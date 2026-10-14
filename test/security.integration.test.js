import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }, { hashPassword }, { signAccessToken }, limiter] =
  await Promise.all([
    import('../src/app.js'),
    import('../src/config/database.js'),
    import('../src/utils/password.js'),
    import('../src/utils/jwt.js'),
    import('../src/middleware/passwordChangeRateLimiter.js'),
  ]);

test('password-change guessing is bounded per authenticated account', { timeout: 60_000 }, async (t) => {
  const fixtureIds = [];
  const marker = `TEST_SECURITY_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  const passwordHash = await hashPassword(password);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { token, body, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, json: await response.json() };
  }

  try {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const suffix of ['a', 'b']) {
        const username = `${marker}_${suffix}`;
        await connection.execute(
          `INSERT INTO users (username, email, password_hash, is_active, must_change_password)
           VALUES (?, ?, ?, 1, 0)`,
          [username, `${username}@example.invalid`, passwordHash],
        );
        const [[row]] = await connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
        fixtureIds.push(row.id);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const [firstToken, secondToken] = fixtureIds.map((id) => signAccessToken(id).accessToken);
    const wrongBody = { currentPassword: 'Not-the-fixture-password', newPassword: randomUUID() };

    await t.test('authentication precedes the password-change limiter', async () => {
      for (const token of [undefined, 'invalid.token.value']) {
        const result = await request('/api/auth/change-password', { token, body: wrongBody });
        assert.equal(result.status, 401);
        assert.equal(result.json.message, 'Authentication required');
      }
    });

    await t.test('attempt eleven is throttled despite changing proxy headers', async () => {
      assert.equal(limiter.PASSWORD_CHANGE_ATTEMPT_LIMIT, 10);
      assert.equal(limiter.PASSWORD_CHANGE_WINDOW_MS, 15 * 60 * 1000);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await request('/api/auth/change-password', {
          token: firstToken, body: wrongBody,
          headers: { 'x-forwarded-for': `192.0.2.${attempt + 1}` },
        });
        assert.equal(result.status, 401);
        assert.equal(result.json.message, 'Current password is incorrect');
      }
      // Correct credentials also stop at the limiter: no password/audit mutation occurs.
      const result = await request('/api/auth/change-password', {
        token: firstToken,
        body: { currentPassword: password, newPassword: randomUUID() },
      });
      assert.equal(result.status, 429);
      assert.equal(result.json.success, false);
      assert.match(result.json.message, /Too many password change attempts/);
      assert.ok(result.headers.get('retry-after'));
      assert.equal(result.headers.get('cache-control'), 'no-store');
      const [[unchanged]] = await pool.execute('SELECT password_hash AS hash FROM users WHERE user_id = ?', [fixtureIds[0]]);
      assert.ok(unchanged.hash === passwordHash, 'Throttling must occur before credential mutation');
      const [[audit]] = await pool.execute('SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ?', [fixtureIds[0]]);
      assert.equal(Number(audit.count), 0);
    });

    await t.test('other accounts and non-password endpoints retain their own access', async () => {
      const other = await request('/api/auth/change-password', { token: secondToken, body: wrongBody });
      assert.equal(other.status, 401);
      assert.equal(other.json.message, 'Current password is incorrect');
      assert.equal((await request('/api/auth/me', { token: firstToken })).status, 200);
      assert.equal((await request('/api/health')).status, 200);
      assert.equal((await request('/api/admin/users', { token: firstToken })).status, 403);
    });
  } finally {
    try {
      // IDs are owned exclusively by this test; keep foreign-key enforcement enabled.
      for (const id of fixtureIds) {
        await pool.execute('DELETE FROM audit_logs WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM users WHERE user_id = ?', [id]);
      }
      const [[residue]] = await pool.execute('SELECT COUNT(*) AS count FROM users WHERE username IN (?, ?)', [`${marker}_a`, `${marker}_b`]);
      assert.equal(Number(residue.count), 0);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await pool.end();
    }
  }
});

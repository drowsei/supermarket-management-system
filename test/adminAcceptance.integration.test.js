import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';

import dotenv from 'dotenv';

import { employeeConfig, userConfig } from '../public/js/contracts.js';
import {
  resourceActionAllowed,
  resourceActionVisible,
} from '../public/js/components/resourcePage.js';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }, { signAccessToken }] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
  import('../src/utils/jwt.js'),
]);

const placeholders = (values) => values.map(() => '?').join(', ');
const parseJson = (value) => typeof value === 'string' ? JSON.parse(value) : value;

async function lastId(connection) {
  const [rows] = await connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
  return rows[0].id;
}

function assertStatus(result, status) {
  assert.equal(result.status, status, result.json.message ?? 'Unexpected HTTP status');
  assert.equal(result.json.success, status < 400);
  if (status >= 400) {
    assert.doesNotMatch(JSON.stringify(result.json), /SQLSTATE|sqlMessage|password_hash|stack|ER_[A-Z_]+/);
  }
}

async function setup(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [admins] = await connection.execute(
      "SELECT CAST(role_id AS CHAR) AS id FROM roles WHERE role_code = 'SYSTEM_ADMIN' AND is_active = 1",
    );
    assert.equal(admins.length, 1);
    const [dates] = await connection.execute('SELECT CAST(CURRENT_DATE() AS CHAR) AS today');
    fixture.today = dates[0].today;

    for (const suffix of ['A', 'B']) {
      await connection.execute(
        `INSERT INTO branches (branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status)
         VALUES (?, ?, '18 Acceptance Street', 'Lagos', 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`P18A${suffix}_${fixture.marker}`, `TEST_P18_ADMIN_${fixture.marker} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }

    for (const [name, permission] of [['users', 'users.manage'], ['grants', 'user_roles.manage']]) {
      await connection.execute(
        'INSERT INTO roles (role_code, role_name, is_active) VALUES (?, ?, 1)',
        [`P18_ADMIN_${fixture.marker}_${name}`, `TEST_P18_ADMIN ${fixture.marker} ${name}`],
      );
      const roleId = await lastId(connection);
      fixture.roleIds.push(roleId);
      fixture.roles[name] = roleId;
      const [result] = await connection.execute(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT ?, permission_id FROM permissions WHERE permission_code = ?`,
        [roleId, permission],
      );
      assert.equal(result.affectedRows, 1);
    }

    for (const name of ['admin', 'users', 'grants', 'target']) {
      const username = `p18.admin.${fixture.marker.toLowerCase()}.${name}`;
      await connection.execute(
        `INSERT INTO users (username, email, password_hash, is_active, must_change_password)
         VALUES (?, ?, 'TEST_P18_ADMIN_NO_PASSWORD_LOGIN', 1, 0)`,
        [username, `${username}@example.invalid`],
      );
      const userId = await lastId(connection);
      fixture.userIds.push(userId);
      fixture.users[name] = userId;
      fixture.tokens[name] = signAccessToken(userId).accessToken;
      const roleId = name === 'admin' ? admins[0].id : fixture.roles[name];
      if (roleId) {
        await connection.execute(
          'INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, NULL)',
          [userId, roleId],
        );
      }
    }
    await connection.commit();
    fixture.committed = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanup(fixture) {
  if (!fixture.committed) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Recover API-created employee IDs even if a response assertion failed.
    const [employees] = await connection.execute(
      'SELECT CAST(employee_id AS CHAR) AS id FROM employees WHERE email IN (?, ?)',
      ['journey', 'race'].map((name) => `${name}.${fixture.marker.toLowerCase()}@p18.example.invalid`),
    );
    const employeeIds = employees.map(({ id }) => id);
    await connection.execute(
      `DELETE FROM audit_logs WHERE user_id IN (${placeholders(fixture.userIds)})`,
      fixture.userIds,
    );
    await connection.execute(
      `DELETE FROM user_roles WHERE user_id IN (${placeholders(fixture.userIds)})`,
      fixture.userIds,
    );
    await connection.execute(
      `DELETE FROM users WHERE user_id IN (${placeholders(fixture.userIds)})`,
      fixture.userIds,
    );
    if (employeeIds.length) {
      await connection.execute(
        `DELETE FROM employee_branch_assignments WHERE employee_id IN (${placeholders(employeeIds)})`,
        employeeIds,
      );
      await connection.execute(
        `DELETE FROM employees WHERE employee_id IN (${placeholders(employeeIds)})`,
        employeeIds,
      );
    }
    await connection.execute(
      `DELETE FROM role_permissions WHERE role_id IN (${placeholders(fixture.roleIds)})`,
      fixture.roleIds,
    );
    await connection.execute(
      `DELETE FROM roles WHERE role_id IN (${placeholders(fixture.roleIds)})`,
      fixture.roleIds,
    );
    await connection.execute(
      `DELETE FROM branches WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    for (const [table, column, ids] of [
      ['branches', 'branch_id', fixture.branchIds],
      ['users', 'user_id', fixture.userIds],
      ['roles', 'role_id', fixture.roleIds],
      ['employees', 'employee_id', employeeIds],
    ]) {
      if (!ids.length) continue;
      const [rows] = await connection.execute(
        `SELECT COUNT(*) AS total FROM ${table} WHERE ${column} IN (${placeholders(ids)})`, ids,
      );
      assert.equal(String(rows[0].total), '0', `${table} acceptance fixtures must be removed`);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

test('Phase 18 employee lifecycle and administration authorization acceptance', { timeout: 60_000 }, async (t) => {
  const fixture = {
    marker: randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase(),
    branchIds: [], roleIds: [], userIds: [], roles: {}, users: {}, tokens: {}, committed: false,
  };
  let server;
  try {
    await setup(fixture);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const send = async (path, { method = 'GET', body, actor = 'admin' } = {}) => {
      const requestId = `P18_ADMIN_${fixture.marker}_${randomUUID()}`;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${fixture.tokens[actor]}`,
          'content-type': 'application/json',
          'x-request-id': requestId,
          'user-agent': 'TEST_PHASE18_ADMIN_ACCEPTANCE/1.0',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json(), requestId };
    };
    const employeeBody = (name) => ({
      firstName: `TEST_P18_ADMIN_${fixture.marker}`, lastName: name,
      email: `${name}.${fixture.marker.toLowerCase()}@p18.example.invalid`,
      phone: '+2348000000018', hireDate: fixture.today,
    });
    const assignmentBody = (index, jobTitle) => ({
      branchId: fixture.branchIds[index], jobTitle, startedOn: fixture.today, isPrimary: false,
    });

    await t.test('one employee retains its generated number through assignments, primary changes and termination', async () => {
      const body = employeeBody('journey');
      const { phone, ...missingPhone } = body;
      assert.ok(phone);
      assertStatus(await send('/api/admin/employees', { method: 'POST', body: missingPhone }), 400);
      assertStatus(await send('/api/admin/employees', {
        method: 'POST', body: { ...body, employeeNumber: 'EMP-999999999' },
      }), 400);
      const created = await send('/api/admin/employees', { method: 'POST', body });
      assertStatus(created, 201);
      const { employeeId, employeeNumber } = created.json.data.employee;
      assert.equal(typeof employeeId, 'string');
      assert.match(employeeNumber, /^EMP-\d+$/);
      const root = `/api/admin/employees/${encodeURIComponent(employeeId)}`;
      const edited = await send(root, { method: 'PATCH', body: { lastName: 'Journey Updated' } });
      assertStatus(edited, 200);
      assert.equal(edited.json.data.employee.employeeNumber, employeeNumber);
      assertStatus(await send(root, { method: 'PATCH', body: { employeeNumber: 'EMP-001' } }), 400);

      const first = await send(`${root}/assignments`, { method: 'POST', body: assignmentBody(0, 'Cashier') });
      assertStatus(first, 201);
      assert.equal(first.json.data.assignment.isPrimary, true);
      const second = await send(`${root}/assignments`, { method: 'POST', body: assignmentBody(1, 'Relief Cashier') });
      assertStatus(second, 201);
      assert.equal(second.json.data.assignment.isPrimary, false);
      const firstId = first.json.data.assignment.assignmentId;
      const secondId = second.json.data.assignment.assignmentId;
      const listedEmployee = async () => {
        const list = await send(`/api/admin/employees?search=${encodeURIComponent(employeeNumber)}`);
        assertStatus(list, 200);
        return list.json.data.items.find((employee) => employee.employeeId === employeeId);
      };
      assert.equal((await listedEmployee()).primaryJobTitle, 'Cashier');
      assert.equal((await listedEmployee()).primaryBranchName, `TEST_P18_ADMIN_${fixture.marker} Branch A`);

      assertStatus(await send(`${root}/assignments/${encodeURIComponent(secondId)}/make-primary`, {
        method: 'POST', body: {},
      }), 200);
      const [primaryRows] = await pool.execute(
        `SELECT CAST(assignment_id AS CHAR) AS id, is_primary AS isPrimary
         FROM employee_branch_assignments WHERE employee_id = ? ORDER BY assignment_id`, [employeeId],
      );
      assert.deepEqual(primaryRows, [{ id: firstId, isPrimary: 0 }, { id: secondId, isPrimary: 1 }]);
      const switched = await listedEmployee();
      assert.equal(switched.primaryBranchName, `TEST_P18_ADMIN_${fixture.marker} Branch B`);
      assert.equal(switched.primaryJobTitle, 'Relief Cashier');

      const ended = await send(`${root}/assignments/${encodeURIComponent(secondId)}/end`, {
        method: 'POST', body: { endedOn: fixture.today },
      });
      assertStatus(ended, 200);
      assert.equal(ended.json.data.assignment.isPrimary, false);
      assert.equal(ended.json.data.assignment.endedOn, fixture.today);
      const terminated = await send(`${root}/terminate`, {
        method: 'POST', body: { terminationDate: fixture.today },
      });
      assertStatus(terminated, 200);
      assert.deepEqual(terminated.json.data.endedAssignmentIds, [firstId]);
      const detail = await send(root);
      assertStatus(detail, 200);
      const retained = detail.json.data.employee;
      assert.equal(retained.employmentStatus, 'TERMINATED');
      assert.equal(retained.employeeNumber, employeeNumber);
      assert.equal(retained.assignments.length, 2);
      assert.ok(retained.assignments.every((assignment) => assignment.endedOn === fixture.today && !assignment.isPrimary));
      assert.equal((await listedEmployee()).primaryBranchName, null);
      assert.equal((await listedEmployee()).primaryJobTitle, null);
      for (const action of employeeConfig.actions.filter((action) => ['Assign branch', 'End assignment', 'Make primary'].includes(action.label))) {
        assert.equal(resourceActionVisible(action, retained), false);
      }
      assertStatus(await send(`${root}/assignments`, { method: 'POST', body: assignmentBody(0, 'Forbidden') }), 409);

      const [audits] = await pool.execute(
        `SELECT action_type AS action, CAST(user_id AS CHAR) AS actor,
                after_values AS afterValues FROM audit_logs WHERE request_id IN (?, ?)`,
        [created.requestId, first.requestId],
      );
      assert.ok(audits.length >= 2);
      assert.ok(audits.every((audit) => audit.actor === fixture.users.admin));
      assert.equal(parseJson(audits.find((audit) => audit.action === 'EMPLOYEE_CREATED').afterValues).employeeNumber, employeeNumber);
      assert.equal(parseJson(audits.find((audit) => audit.action === 'EMPLOYEE_BRANCH_ASSIGNED').afterValues).isPrimary, true);
      assert.doesNotMatch(JSON.stringify(audits), /password|accessToken|secret/i);
    });

    await t.test('competing first branch assignments produce exactly one primary and matching audit values', async () => {
      const created = await send('/api/admin/employees', { method: 'POST', body: employeeBody('race') });
      assertStatus(created, 201);
      const employeeId = created.json.data.employee.employeeId;
      const results = await Promise.all([0, 1].map((index) => send(
        `/api/admin/employees/${encodeURIComponent(employeeId)}/assignments`,
        { method: 'POST', body: assignmentBody(index, `Concurrent Cashier ${index}`) },
      )));
      results.forEach((result) => assertStatus(result, 201));
      assert.deepEqual(results.map((result) => result.json.data.assignment.isPrimary).sort(), [false, true]);
      const [rows] = await pool.execute(
        `SELECT CAST(assignment_id AS CHAR) AS id, is_primary AS isPrimary
         FROM employee_branch_assignments WHERE employee_id = ? AND ended_on IS NULL`, [employeeId],
      );
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((row) => row.isPrimary === 1).length, 1);
      for (const result of results) {
        const assignment = result.json.data.assignment;
        assert.equal(rows.find((row) => row.id === assignment.assignmentId).isPrimary === 1, assignment.isPrimary);
        const [audits] = await pool.execute(
          "SELECT after_values AS afterValues FROM audit_logs WHERE request_id = ? AND action_type = 'EMPLOYEE_BRANCH_ASSIGNED'",
          [result.requestId],
        );
        assert.equal(audits.length, 1);
        assert.equal(parseJson(audits[0].afterValues).isPrimary, assignment.isPrimary);
      }
    });

    await t.test('user management and role assignment remain separate in live API enforcement and frontend visibility', async () => {
      const authorizations = {};
      for (const actor of ['users', 'grants']) {
        const me = await send('/api/auth/me', { actor });
        assertStatus(me, 200);
        authorizations[actor] = me.json.data.authorization;
      }
      for (const label of ['Grant role', 'Revoke role']) {
        const action = userConfig.actions.find((candidate) => candidate.label === label);
        assert.ok(action);
        assert.equal(resourceActionAllowed(action, userConfig, authorizations.users), false);
        assert.equal(resourceActionAllowed(action, userConfig, authorizations.grants), true);
      }
      const root = `/api/admin/users/${encodeURIComponent(fixture.users.target)}`;
      const deniedEdit = await send(root, { actor: 'grants', method: 'PATCH', body: { isActive: false } });
      assertStatus(deniedEdit, 403);
      assertStatus(await send(root, {
        actor: 'users', method: 'PATCH', body: { email: `updated.${fixture.marker.toLowerCase()}@p18.example.invalid` },
      }), 200);
      const grantBody = { roleId: fixture.roles.users, branchId: null };
      const deniedGrant = await send(`${root}/roles`, { actor: 'users', method: 'POST', body: grantBody });
      assertStatus(deniedGrant, 403);
      const granted = await send(`${root}/roles`, { actor: 'grants', method: 'POST', body: grantBody });
      assertStatus(granted, 201);
      const grantId = granted.json.data.userRole.userRoleId;
      assert.equal(typeof grantId, 'string');
      assert.equal(granted.json.data.userRole.assignedByUserId, fixture.users.grants);
      const deniedRevoke = await send(`${root}/roles/${encodeURIComponent(grantId)}`, { actor: 'users', method: 'DELETE' });
      assertStatus(deniedRevoke, 403);
      assertStatus(await send(`${root}/roles/${encodeURIComponent(grantId)}`, { actor: 'grants', method: 'DELETE' }), 200);
      const [remaining] = await pool.execute('SELECT COUNT(*) AS total FROM user_roles WHERE user_id = ?', [fixture.users.target]);
      assert.equal(String(remaining[0].total), '0');
      const [deniedAudits] = await pool.execute(
        'SELECT COUNT(*) AS total FROM audit_logs WHERE request_id IN (?, ?, ?)',
        [deniedEdit.requestId, deniedGrant.requestId, deniedRevoke.requestId],
      );
      assert.equal(String(deniedAudits[0].total), '0');
    });
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      try { await cleanup(fixture); } finally { await pool.end(); }
    }
  }
});

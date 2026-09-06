import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import {
  SYSTEM_ADMIN_ROLE,
  USER_CREDENTIAL_LOCK_NAME,
  USER_CREDENTIAL_LOCK_TIMEOUT_SECONDS,
} from '../src/config/accessControl.js';
import {
  ensureAccessControl,
  findActiveGlobalSystemAdministrator,
} from '../src/repositories/accessControlSeed.repository.js';
import { insertAuditLog } from '../src/repositories/audit.repository.js';
import { databaseBoolean } from '../src/utils/record.js';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_CHARACTERS,
  hashPassword,
} from '../src/utils/password.js';
import {
  CliError,
  loadDatabasePool,
  safeCliError,
  verifyExpectedDatabase,
} from './lib/cli-runtime.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,99}$/;
const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUsername(value) {
  const username = value.trim().toLowerCase();

  if (!USERNAME_PATTERN.test(username)) {
    throw new CliError(
      'Username must contain 3 to 100 lowercase letters, numbers, dots, underscores, or hyphens, and must start with a letter or number.',
    );
  }

  return username;
}

function validateEmail(value) {
  const email = value.trim().toLowerCase();

  if (email.length > 254 || !SIMPLE_EMAIL_PATTERN.test(email)) {
    throw new CliError('Enter a valid email address of at most 254 characters.');
  }

  return email;
}

function validatePassword(password) {
  if ([...password].length < MIN_PASSWORD_CHARACTERS) {
    throw new CliError(
      `Password must contain at least ${MIN_PASSWORD_CHARACTERS} characters.`,
    );
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new CliError(
      `Password must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
    );
  }
}

async function promptVisibleAccountDetails() {
  const abortController = new AbortController();
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const abort = () => abortController.abort();

  terminal.once('SIGINT', abort);

  try {
    const username = await terminal.question('Username: ', {
      signal: abortController.signal,
    });
    const email = await terminal.question('Email: ', {
      signal: abortController.signal,
    });

    return {
      email: validateEmail(email),
      username: validateUsername(username),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new CliError('Administrator bootstrap cancelled.', {
        exitCode: 130,
      });
    }

    throw error;
  } finally {
    terminal.off('SIGINT', abort);
    terminal.close();
  }
}

function promptHidden(prompt) {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== 'function'
  ) {
    throw new CliError(
      'Secure password input requires an interactive terminal; redirected or piped input is not accepted.',
    );
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const previousRawMode = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    let value = '';
    let settled = false;

    readline.emitKeypressEvents(input);

    function restoreTerminal() {
      input.off('keypress', handleKeypress);
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
      process.off('exit', handleProcessExit);

      if (input.isTTY && input.isRaw !== previousRawMode) {
        input.setRawMode(previousRawMode);
      }

      if (wasPaused) {
        input.pause();
      }
    }

    function settle(callback, result) {
      if (settled) {
        return;
      }

      settled = true;
      restoreTerminal();
      output.write('\n');
      callback(result);
    }

    function cancel(exitCode) {
      settle(
        reject,
        new CliError('Administrator bootstrap cancelled.', { exitCode }),
      );
    }

    function handleSigint() {
      cancel(130);
    }

    function handleSigterm() {
      cancel(143);
    }

    function handleProcessExit() {
      restoreTerminal();
    }

    function handleKeypress(character, key = {}) {
      if (key.ctrl && key.name === 'c') {
        cancel(130);
        return;
      }

      if (key.ctrl && key.name === 'd') {
        cancel(130);
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        settle(resolve, value);
        return;
      }

      if (key.name === 'backspace') {
        value = [...value].slice(0, -1).join('');
        return;
      }

      if (key.ctrl && key.name === 'u') {
        value = '';
        return;
      }

      if (
        key.ctrl ||
        key.meta ||
        key.name === 'escape' ||
        key.name === 'tab' ||
        key.name === 'delete' ||
        key.name === 'up' ||
        key.name === 'down' ||
        key.name === 'left' ||
        key.name === 'right' ||
        key.name === 'home' ||
        key.name === 'end' ||
        key.name === 'pageup' ||
        key.name === 'pagedown'
      ) {
        return;
      }

      if (
        typeof character === 'string' &&
        character.length > 0 &&
        !/[\u0000-\u001f\u007f]/u.test(character)
      ) {
        value += character;
      }
    }

    output.write(prompt);
    input.setRawMode(true);
    input.on('keypress', handleKeypress);
    process.once('SIGINT', handleSigint);
    process.once('SIGTERM', handleSigterm);
    process.once('exit', handleProcessExit);
    input.resume();
  });
}

async function promptPassword() {
  const password = await promptHidden('Password: ');
  validatePassword(password);

  const confirmation = await promptHidden('Confirm password: ');

  if (password !== confirmation) {
    throw new CliError('Password confirmation does not match.');
  }

  return password;
}

async function ensureIdentifierAvailability(connection, username, email) {
  const [rows] = await connection.execute(
    `SELECT CAST(user_id AS CHAR) AS userId
     FROM users
     WHERE username IN (?, ?)
        OR email IN (?, ?)
     FOR UPDATE`,
    [username, email, username, email],
  );

  if (rows.length > 0) {
    throw new CliError(
      'A user account already uses the requested username or email.',
    );
  }
}

async function acquireUserCredentialLock(connection) {
  const [rows] = await connection.execute(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [USER_CREDENTIAL_LOCK_NAME, USER_CREDENTIAL_LOCK_TIMEOUT_SECONDS],
  );

  if (!databaseBoolean(rows[0]?.acquired)) {
    throw new CliError(
      'User account provisioning is busy. Try the bootstrap command again shortly.',
    );
  }
}

async function releaseUserCredentialLock(connection) {
  const [rows] = await connection.execute(
    'SELECT RELEASE_LOCK(?) AS released',
    [USER_CREDENTIAL_LOCK_NAME],
  );

  return databaseBoolean(rows[0]?.released);
}

async function insertBootstrapAdministrator(
  connection,
  { username, email, passwordHash, systemAdminRoleId },
) {
  try {
    await connection.execute(
      `INSERT INTO users (
         employee_id,
         username,
         email,
         password_hash,
         is_active,
         must_change_password
       ) VALUES (NULL, ?, ?, ?, 1, 0)`,
      [username, email, passwordHash],
    );
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new CliError(
        'A user account already uses the requested username or email.',
      );
    }

    throw error;
  }

  const [userRows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS userId',
  );
  const userId = userRows[0]?.userId;

  if (!userId) {
    throw new CliError('The bootstrap administrator could not be created.');
  }

  await connection.execute(
    `INSERT INTO user_roles (
       user_id,
       role_id,
       branch_id,
       assigned_by_user_id
     ) VALUES (?, ?, NULL, NULL)`,
    [userId, systemAdminRoleId],
  );

  const [userRoleRows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS userRoleId',
  );
  const userRoleId = userRoleRows[0]?.userRoleId;

  if (!userRoleId) {
    throw new CliError(
      'The global SYSTEM_ADMIN assignment could not be created.',
    );
  }

  await insertAuditLog(connection, {
    actionType: 'USER_CREATED',
    entityType: 'users',
    entityRecordId: userId,
    afterValues: {
      employeeId: null,
      username,
      email,
      isActive: true,
      mustChangePassword: false,
    },
    notes:
      'Initial system administrator created by the interactive bootstrap CLI.',
  });

  await insertAuditLog(connection, {
    actionType: 'USER_ROLE_ASSIGNED',
    entityType: 'user_roles',
    entityRecordId: userRoleId,
    afterValues: {
      userId,
      roleCode: SYSTEM_ADMIN_ROLE.code,
      branchId: null,
    },
    notes:
      'Global SYSTEM_ADMIN role assigned by the interactive bootstrap CLI.',
  });

  return userId;
}

async function bootstrapAdministrator() {
  let pool;
  let connection;
  let transactionStarted = false;
  let credentialLockAcquired = false;
  let password;
  let passwordHash;

  try {
    if (process.argv.length > 2) {
      throw new CliError(
        'This command accepts no arguments; enter account details interactively.',
      );
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError(
        'Administrator bootstrap requires an interactive terminal.',
      );
    }

    pool = await loadDatabasePool({ requireBcrypt: true });

    connection = await pool.getConnection();
    await verifyExpectedDatabase(connection);

    const existingAdministrator =
      await findActiveGlobalSystemAdministrator(connection);

    connection.release();
    connection = undefined;

    if (existingAdministrator) {
      throw new CliError(
        'An active global SYSTEM_ADMIN already exists. Use the authenticated user administration API for additional accounts.',
      );
    }

    const account = await promptVisibleAccountDetails();
    password = await promptPassword();
    passwordHash = await hashPassword(password);
    password = undefined;

    connection = await pool.getConnection();
    await verifyExpectedDatabase(connection);
    await acquireUserCredentialLock(connection);
    credentialLockAcquired = true;
    await connection.beginTransaction();
    transactionStarted = true;

    const accessControl = await ensureAccessControl(connection);

    if (!accessControl.systemAdminRole.isActive) {
      throw new CliError(
        'SYSTEM_ADMIN exists but is inactive. It was not reactivated automatically; review that role before bootstrapping an account.',
      );
    }

    const concurrentAdministrator =
      await findActiveGlobalSystemAdministrator(connection, { lock: true });

    if (concurrentAdministrator) {
      throw new CliError(
        'An active global SYSTEM_ADMIN now exists. No additional bootstrap account was created.',
      );
    }

    await ensureIdentifierAvailability(
      connection,
      account.username,
      account.email,
    );

    const userId = await insertBootstrapAdministrator(connection, {
      ...account,
      passwordHash,
      systemAdminRoleId: accessControl.systemAdminRole.roleId,
    });

    await connection.commit();
    transactionStarted = false;

    console.log(
      `Initial SYSTEM_ADMIN account created successfully for ${account.username} (user ID ${userId}).`,
    );
  } catch (error) {
    if (transactionStarted && connection) {
      try {
        await connection.rollback();
      } catch {
        // The original failure is more useful than a secondary rollback failure.
      }
    }

    const safeError = safeCliError(
      error,
      'Administrator bootstrap failed. The transaction was rolled back where possible; rerunning the command is safe.',
    );
    console.error(safeError.message);
    process.exitCode = safeError.exitCode;
  } finally {
    password = undefined;
    passwordHash = undefined;

    if (credentialLockAcquired && connection) {
      try {
        const released = await releaseUserCredentialLock(connection);

        if (!released) {
          throw new Error('The advisory lock was not owned by this connection.');
        }
      } catch {
        console.error(
          'The user-credential lock could not be released cleanly; the MySQL connection was discarded.',
        );
        try {
          connection.destroy();
        } catch {
          // Ending the pool below remains a second cleanup path.
        }
        connection = undefined;
        process.exitCode = 1;
      }
    }

    connection?.release();

    if (pool) {
      try {
        await pool.end();
      } catch {
        console.error('The MySQL connection pool could not be closed cleanly.');
        process.exitCode = 1;
      }
    }
  }
}

await bootstrapAdministrator();

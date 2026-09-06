import {
  ensureAccessControl,
} from '../src/repositories/accessControlSeed.repository.js';
import {
  loadDatabasePool,
  safeCliError,
  verifyExpectedDatabase,
} from './lib/cli-runtime.js';

async function seedAccessControl() {
  let pool;
  let connection;
  let transactionStarted = false;

  try {
    pool = await loadDatabasePool();
    connection = await pool.getConnection();
    await verifyExpectedDatabase(connection);
    await connection.beginTransaction();
    transactionStarted = true;

    const result = await ensureAccessControl(connection);

    await connection.commit();
    transactionStarted = false;

    console.log(
      `Access-control seed complete: ${result.permissionCount} canonical permissions assigned to SYSTEM_ADMIN.`,
    );

    if (!result.systemAdminRole.isActive) {
      console.warn(
        'SYSTEM_ADMIN already exists but is inactive; it was not reactivated automatically.',
      );
    }
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
      'Access-control seeding failed. The transaction was rolled back where possible; rerunning the seed is safe.',
    );
    console.error(safeError.message);
    process.exitCode = safeError.exitCode;
  } finally {
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

await seedAccessControl();

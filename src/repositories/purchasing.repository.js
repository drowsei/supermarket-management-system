import { randomUUID } from 'node:crypto';

import pool from '../config/database.js';
import { withCatalogTransaction } from './productCatalog.repository.js';

function generateDocumentNumber(prefix) {
  return `${prefix}-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

async function selectUtcNow(connection) {
  const [rows] = await connection.execute(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS utcNow",
  );
  return rows[0].utcNow;
}

async function lockOperationalContext(connection, branchId, actorEmployeeId) {
  if (!actorEmployeeId) return { outcome: 'actor_required' };

  const [employeeRows] = await connection.execute(
    `SELECT CAST(employee_id AS CHAR) AS employeeId, employment_status AS status
     FROM employees
     WHERE employee_id = ?
     LIMIT 1
     FOR UPDATE`,
    [actorEmployeeId],
  );
  const employee = employeeRows[0];
  if (!employee || employee.status !== 'ACTIVE') {
    return { outcome: 'actor_not_active' };
  }

  const [branchRows] = await connection.execute(
    `SELECT
       CAST(branch_id AS CHAR) AS branchId,
       currency_code AS currencyCode,
       status
     FROM branches
     WHERE branch_id = ?
     LIMIT 1
     FOR UPDATE`,
    [branchId],
  );
  const branch = branchRows[0];
  if (!branch) return { outcome: 'branch_not_found' };
  if (branch.status !== 'ACTIVE') return { outcome: 'branch_not_active' };

  const [assignmentRows] = await connection.execute(
    `SELECT assignment_id
     FROM employee_branch_assignments
     WHERE employee_id = ?
       AND branch_id = ?
       AND started_on <= CURRENT_DATE()
       AND (ended_on IS NULL OR ended_on >= CURRENT_DATE())
     ORDER BY assignment_id
     LIMIT 1
     FOR UPDATE`,
    [actorEmployeeId, branchId],
  );
  if (assignmentRows.length === 0) return { outcome: 'actor_not_assigned' };

  return { outcome: 'valid', branch, employee };
}

function operationalOutcome(result) {
  return result.outcome === 'valid' ? null : result.outcome;
}

export {
  generateDocumentNumber,
  lockOperationalContext,
  operationalOutcome,
  pool,
  selectUtcNow,
  withCatalogTransaction as withPurchasingTransaction,
};

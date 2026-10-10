import pool from '../config/database.js';
import { insertAuditLog } from './audit.repository.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';

const EMPLOYEE_COLUMNS = `
  CAST(e.employee_id AS CHAR) AS employeeId,
  e.employee_number AS employeeNumber,
  e.first_name AS firstName,
  e.last_name AS lastName,
  e.email,
  e.phone,
  DATE_FORMAT(e.hire_date, '%Y-%m-%d') AS hireDate,
  DATE_FORMAT(e.termination_date, '%Y-%m-%d') AS terminationDate,
  e.employment_status AS employmentStatus,
  e.created_at AS createdAt,
  e.updated_at AS updatedAt
`;

const EMPLOYEE_LIST_COLUMNS = `
  ${EMPLOYEE_COLUMNS},
  primary_branch.branch_name AS primaryBranchName,
  primary_assignment.job_title AS primaryJobTitle
`;

const EMPLOYEE_LIST_JOINS = `
  LEFT JOIN (
    SELECT employee_id, MAX(assignment_id) AS assignment_id
    FROM employee_branch_assignments
    WHERE ended_on IS NULL AND is_primary = 1
    GROUP BY employee_id
    HAVING COUNT(*) = 1
  ) current_primary
    ON current_primary.employee_id = e.employee_id
   AND e.employment_status <> 'TERMINATED'
  LEFT JOIN employee_branch_assignments primary_assignment
    ON primary_assignment.assignment_id = current_primary.assignment_id
  LEFT JOIN branches primary_branch
    ON primary_branch.branch_id = primary_assignment.branch_id
`;

const ASSIGNMENT_COLUMNS = `
  CAST(eba.assignment_id AS CHAR) AS assignmentId,
  CAST(eba.employee_id AS CHAR) AS employeeId,
  CAST(eba.branch_id AS CHAR) AS branchId,
  b.branch_code AS branchCode,
  b.branch_name AS branchName,
  b.status AS branchStatus,
  eba.job_title AS jobTitle,
  DATE_FORMAT(eba.started_on, '%Y-%m-%d') AS startedOn,
  DATE_FORMAT(eba.ended_on, '%Y-%m-%d') AS endedOn,
  eba.is_primary AS isPrimary,
  eba.created_at AS createdAt,
  eba.updated_at AS updatedAt
`;

const EMPLOYEE_UPDATE_COLUMNS = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  hireDate: 'hire_date',
  employmentStatus: 'employment_status',
};

const EMPLOYEE_NUMBER_LOCK_NAME = 'sms.employee-number-sequence';
const EMPLOYEE_NUMBER_LOCK_TIMEOUT_SECONDS = 10;

function normalizeEmployee(row) {
  if (!row) {
    return null;
  }

  return {
    employeeId: row.employeeId,
    employeeNumber: row.employeeNumber,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? null,
    phone: row.phone ?? null,
    hireDate: row.hireDate,
    terminationDate: row.terminationDate ?? null,
    employmentStatus: row.employmentStatus,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function normalizeEmployeeListItem(row) {
  const employee = normalizeEmployee(row);
  if (!employee) return null;
  return {
    ...employee,
    primaryBranchName: row.primaryBranchName ?? null,
    primaryJobTitle: row.primaryJobTitle ?? null,
  };
}

function normalizeAssignment(row) {
  if (!row) {
    return null;
  }

  return {
    assignmentId: row.assignmentId,
    employeeId: row.employeeId,
    branchId: row.branchId,
    branchCode: row.branchCode,
    branchName: row.branchName,
    branchStatus: row.branchStatus,
    jobTitle: row.jobTitle,
    startedOn: row.startedOn,
    endedOn: row.endedOn ?? null,
    isPrimary: databaseBoolean(row.isPrimary),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function employeeAuditSnapshot(employee) {
  return {
    employeeId: employee.employeeId,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    phone: employee.phone,
    hireDate: employee.hireDate,
    terminationDate: employee.terminationDate,
    employmentStatus: employee.employmentStatus,
  };
}

function assignmentAuditSnapshot(assignment) {
  return {
    assignmentId: assignment.assignmentId,
    employeeId: assignment.employeeId,
    branchId: assignment.branchId,
    jobTitle: assignment.jobTitle,
    startedOn: assignment.startedOn,
    endedOn: assignment.endedOn,
    isPrimary: assignment.isPrimary,
  };
}

async function withTransaction(work, { namedLock = null } = {}) {
  const connection = await pool.getConnection();
  let namedLockAcquired = false;
  let connectionDestroyed = false;

  try {
    await connection.beginTransaction();

    if (namedLock) {
      const [lockRows] = await connection.execute(
        'SELECT GET_LOCK(?, ?) AS lockAcquired',
        [namedLock, EMPLOYEE_NUMBER_LOCK_TIMEOUT_SECONDS],
      );

      if (
        lockRows[0].lockAcquired !== 1 &&
        lockRows[0].lockAcquired !== '1'
      ) {
        const error = new Error('Employee number sequence lock was not acquired.');
        error.code = 'EMPLOYEE_NUMBER_SEQUENCE_BUSY';
        throw error;
      }

      namedLockAcquired = true;
    }

    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }

    throw error;
  } finally {
    if (namedLockAcquired) {
      try {
        const [releaseRows] = await connection.execute(
          'SELECT RELEASE_LOCK(?) AS lockReleased',
          [namedLock],
        );

        if (
          releaseRows[0].lockReleased !== 1 &&
          releaseRows[0].lockReleased !== '1'
        ) {
          connection.destroy();
          connectionDestroyed = true;
        }
      } catch {
        connection.destroy();
        connectionDestroyed = true;
      }
    }

    if (!connectionDestroyed) {
      connection.release();
    }
  }
}

function formatEmployeeNumber(sequence) {
  if (typeof sequence !== 'bigint' || sequence < 1n) {
    throw new Error('Employee number sequence must be a positive bigint.');
  }

  return `EMP-${sequence.toString().padStart(3, '0')}`;
}

async function getNextEmployeeNumber(connection) {
  const [rows] = await connection.execute(
    `SELECT CAST(
       COALESCE(
         MAX(CAST(SUBSTRING(employee_number, 5) AS DECIMAL(28, 0))),
         0
       ) AS CHAR
     ) AS maximumSequence
     FROM employees
     WHERE REGEXP_LIKE(employee_number, '^EMP-[0-9]+$', 'c')`,
  );

  return formatEmployeeNumber(BigInt(rows[0].maximumSequence) + 1n);
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

async function selectCurrentDate(connection) {
  const [rows] = await connection.execute(
    "SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS currentDate",
  );

  return rows[0].currentDate;
}

async function selectEmployee(executor, employeeId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${EMPLOYEE_COLUMNS}
     FROM employees e
     WHERE e.employee_id = ?
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [employeeId],
  );

  return normalizeEmployee(rows[0]);
}

async function selectAssignment(
  executor,
  employeeId,
  assignmentId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM employee_branch_assignments eba
     INNER JOIN branches b ON b.branch_id = eba.branch_id
     WHERE eba.employee_id = ? AND eba.assignment_id = ?
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [employeeId, assignmentId],
  );

  return normalizeAssignment(rows[0]);
}

async function listEmployees({
  employmentStatus,
  branchId,
  search,
  limit,
  offset,
}) {
  const conditions = [];
  const values = [];

  if (employmentStatus) {
    conditions.push('e.employment_status = ?');
    values.push(employmentStatus);
  }

  if (branchId) {
    conditions.push(
      `EXISTS (
         SELECT 1
         FROM employee_branch_assignments filter_assignment
         WHERE filter_assignment.employee_id = e.employee_id
           AND filter_assignment.branch_id = ?
           AND filter_assignment.started_on <= CURRENT_DATE()
           AND (
             filter_assignment.ended_on IS NULL
             OR filter_assignment.ended_on >= CURRENT_DATE()
           )
       )`,
    );
    values.push(branchId);
  }

  if (search) {
    conditions.push(
      `LOCATE(
         ?,
         CONCAT_WS(
           ' ',
           e.employee_number,
           e.first_name,
           e.last_name,
           COALESCE(e.email, ''),
           COALESCE(e.phone, '')
         )
       ) > 0`,
    );
    values.push(search);
  }

  const whereClause =
    conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM employees e
     ${whereClause}`,
    values,
  );
  const [rows] = await pool.execute(
    `SELECT ${EMPLOYEE_LIST_COLUMNS}
     FROM employees e
     ${EMPLOYEE_LIST_JOINS}
     ${whereClause}
     ORDER BY e.last_name, e.first_name, e.employee_id
     LIMIT ? OFFSET ?`,
    [...values, limit, offset],
  );

  return {
    items: rows.map(normalizeEmployeeListItem),
    totalItems: countRows[0].totalItems,
  };
}

async function findEmployeeById(employeeId) {
  return selectEmployee(pool, employeeId);
}

async function findAssignmentsByEmployeeId(employeeId) {
  const [rows] = await pool.execute(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM employee_branch_assignments eba
     INNER JOIN branches b ON b.branch_id = eba.branch_id
     WHERE eba.employee_id = ?
     ORDER BY
       (eba.ended_on IS NULL) DESC,
       eba.is_primary DESC,
       eba.started_on DESC,
       eba.assignment_id DESC`,
    [employeeId],
  );

  return rows.map(normalizeAssignment);
}

async function createEmployeeRecord(input, auditContext) {
  return withTransaction(async (connection) => {
    const employeeNumber = await getNextEmployeeNumber(connection);

    await connection.execute(
      `INSERT INTO employees (
         employee_number,
         first_name,
         last_name,
         email,
         phone,
         hire_date,
         employment_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeNumber,
        input.firstName,
        input.lastName,
        input.email,
        input.phone,
        input.hireDate,
        input.employmentStatus,
      ],
    );
    const employeeId = await getLastInsertId(connection);
    const employee = await selectEmployee(connection, employeeId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'EMPLOYEE_CREATED',
      entityType: 'employees',
      entityRecordId: employeeId,
      beforeValues: null,
      afterValues: employeeAuditSnapshot(employee),
      notes: 'Employee record created through the administration API.',
    });

    return employee;
  }, { namedLock: EMPLOYEE_NUMBER_LOCK_NAME });
}

async function updateEmployeeRecord(employeeId, update, auditContext) {
  return withTransaction(async (connection) => {
    const currentEmployee = await selectEmployee(connection, employeeId, {
      forUpdate: true,
    });

    if (!currentEmployee) {
      return { outcome: 'not_found' };
    }

    if (currentEmployee.employmentStatus === 'TERMINATED') {
      return { outcome: 'terminated' };
    }

    if (update.hireDate !== undefined) {
      const [conflictingRows] = await connection.execute(
        `SELECT 1
         FROM employee_branch_assignments
         WHERE employee_id = ? AND started_on < ?
         LIMIT 1`,
        [employeeId, update.hireDate],
      );

      if (conflictingRows.length > 0) {
        return { outcome: 'assignment_date_conflict' };
      }
    }

    const changedEntries = Object.entries(update).filter(
      ([field, value]) => currentEmployee[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', employee: currentEmployee };
    }

    const setClause = changedEntries
      .map(([field]) => `${EMPLOYEE_UPDATE_COLUMNS[field]} = ?`)
      .join(', ');
    await connection.execute(
      `UPDATE employees SET ${setClause} WHERE employee_id = ?`,
      [...changedEntries.map(([, value]) => value), employeeId],
    );

    const employee = await selectEmployee(connection, employeeId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'EMPLOYEE_UPDATED',
      entityType: 'employees',
      entityRecordId: employeeId,
      beforeValues: employeeAuditSnapshot(currentEmployee),
      afterValues: employeeAuditSnapshot(employee),
      notes: 'Employee record updated through the administration API.',
    });

    return { outcome: 'updated', employee };
  });
}

async function terminateEmployeeRecord(
  employeeId,
  terminationDate,
  auditContext,
) {
  return withTransaction(async (connection) => {
    const currentEmployee = await selectEmployee(connection, employeeId, {
      forUpdate: true,
    });

    if (!currentEmployee) {
      return { outcome: 'not_found' };
    }

    if (
      currentEmployee.employmentStatus === 'TERMINATED' &&
      currentEmployee.terminationDate !== terminationDate
    ) {
      return { outcome: 'different_termination_date' };
    }

    if (currentEmployee.employmentStatus === 'TERMINATED') {
      return {
        outcome: 'unchanged',
        employee: currentEmployee,
        linkedUserDeactivated: false,
        endedAssignmentIds: [],
      };
    }

    const currentDate = await selectCurrentDate(connection);

    if (terminationDate < currentEmployee.hireDate) {
      return { outcome: 'before_hire_date' };
    }

    if (terminationDate > currentDate) {
      return { outcome: 'future_termination_date' };
    }

    const [assignmentRows] = await connection.execute(
      `SELECT ${ASSIGNMENT_COLUMNS}
       FROM employee_branch_assignments eba
       INNER JOIN branches b ON b.branch_id = eba.branch_id
       WHERE eba.employee_id = ?
         AND (eba.ended_on IS NULL OR eba.ended_on > ?)
       FOR UPDATE`,
      [employeeId, terminationDate],
    );
    const affectedAssignments = assignmentRows.map(normalizeAssignment);

    const [userRows] = await connection.execute(
      `SELECT
         CAST(user_id AS CHAR) AS userId,
         username,
         email,
         is_active AS isActive,
         must_change_password AS mustChangePassword
       FROM users
       WHERE employee_id = ?
       FOR UPDATE`,
      [employeeId],
    );
    const linkedUser = userRows[0]
      ? {
          userId: userRows[0].userId,
          username: userRows[0].username,
          email: userRows[0].email,
          isActive: databaseBoolean(userRows[0].isActive),
          mustChangePassword: databaseBoolean(
            userRows[0].mustChangePassword,
          ),
        }
      : null;
    await connection.execute(
      `UPDATE employees
       SET employment_status = 'TERMINATED', termination_date = ?
       WHERE employee_id = ?`,
      [terminationDate, employeeId],
    );

    for (const assignment of affectedAssignments) {
      // The schema does not have a separate cancellation status. A scheduled
      // future assignment is closed on its start date so its date CHECK remains
      // valid; the TERMINATED employee state prevents it from granting access.
      const assignmentEndDate =
        assignment.startedOn > terminationDate
          ? assignment.startedOn
          : terminationDate;
      await connection.execute(
        `UPDATE employee_branch_assignments
         SET ended_on = ?, is_primary = 0
         WHERE assignment_id = ?`,
        [assignmentEndDate, assignment.assignmentId],
      );
    }

    if (linkedUser?.isActive) {
      await connection.execute(
        'UPDATE users SET is_active = 0 WHERE user_id = ?',
        [linkedUser.userId],
      );
    }

    const employee = await selectEmployee(connection, employeeId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'EMPLOYEE_TERMINATED',
      entityType: 'employees',
      entityRecordId: employeeId,
      beforeValues: employeeAuditSnapshot(currentEmployee),
      afterValues: employeeAuditSnapshot(employee),
      notes: 'Employee terminated through the administration API.',
    });

    for (const assignment of affectedAssignments) {
      await insertAuditLog(connection, {
        auditContext,
        branchId: assignment.branchId,
        actionType: 'EMPLOYEE_BRANCH_ASSIGNMENT_ENDED',
        entityType: 'employee_branch_assignments',
        entityRecordId: assignment.assignmentId,
        beforeValues: assignmentAuditSnapshot(assignment),
        afterValues: assignmentAuditSnapshot({
          ...assignment,
          endedOn:
            assignment.startedOn > terminationDate
              ? assignment.startedOn
              : terminationDate,
          isPrimary: false,
        }),
        notes: 'Assignment ended as part of employee termination.',
      });
    }

    if (linkedUser?.isActive) {
      await insertAuditLog(connection, {
        auditContext,
        actionType: 'USER_UPDATED',
        entityType: 'users',
        entityRecordId: linkedUser.userId,
        beforeValues: {
          userId: linkedUser.userId,
          employeeId,
          username: linkedUser.username,
          email: linkedUser.email,
          isActive: true,
          mustChangePassword: linkedUser.mustChangePassword,
        },
        afterValues: {
          userId: linkedUser.userId,
          employeeId,
          username: linkedUser.username,
          email: linkedUser.email,
          isActive: false,
          mustChangePassword: linkedUser.mustChangePassword,
        },
        notes: 'Linked login disabled as part of employee termination.',
      });
    }

    return {
      outcome: 'terminated',
      employee,
      linkedUserDeactivated: Boolean(linkedUser?.isActive),
      endedAssignmentIds: affectedAssignments.map(
        (assignment) => assignment.assignmentId,
      ),
    };
  });
}

async function createAssignmentRecord(employeeId, input, auditContext) {
  return withTransaction(async (connection) => {
    const employee = await selectEmployee(connection, employeeId, {
      forUpdate: true,
    });

    if (!employee) {
      return { outcome: 'employee_not_found' };
    }

    if (employee.employmentStatus === 'TERMINATED') {
      return { outcome: 'employee_terminated' };
    }

    if (input.startedOn < employee.hireDate) {
      return { outcome: 'before_hire_date' };
    }

    const [branchRows] = await connection.execute(
      `SELECT
         CAST(branch_id AS CHAR) AS branchId,
         branch_code AS branchCode,
         branch_name AS branchName,
         status
       FROM branches
       WHERE branch_id = ?
       FOR UPDATE`,
      [input.branchId],
    );
    const branch = branchRows[0];

    if (!branch) {
      return { outcome: 'branch_not_found' };
    }

    if (branch.status !== 'ACTIVE') {
      return { outcome: 'branch_not_active' };
    }

    const currentDate = await selectCurrentDate(connection);

    const [activeAssignmentRows] = await connection.execute(
      `SELECT assignment_id
       FROM employee_branch_assignments
       WHERE employee_id = ? AND ended_on IS NULL
       FOR UPDATE`,
      [employeeId],
    );
    const effectiveIsPrimary =
      activeAssignmentRows.length === 0 || input.isPrimary;

    if (effectiveIsPrimary && input.startedOn > currentDate) {
      return { outcome: 'future_primary_assignment' };
    }

    const [overlapRows] = await connection.execute(
      `SELECT CAST(assignment_id AS CHAR) AS assignmentId
       FROM employee_branch_assignments
       WHERE employee_id = ?
         AND branch_id = ?
         AND (ended_on IS NULL OR ended_on >= ?)
       LIMIT 1
       FOR UPDATE`,
      [employeeId, input.branchId, input.startedOn],
    );

    if (overlapRows.length > 0) {
      return { outcome: 'overlapping_assignment' };
    }

    let previousPrimary = null;

    if (effectiveIsPrimary) {
      const [primaryRows] = await connection.execute(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM employee_branch_assignments eba
         INNER JOIN branches b ON b.branch_id = eba.branch_id
         WHERE eba.employee_id = ?
           AND eba.ended_on IS NULL
           AND eba.is_primary = 1
         FOR UPDATE`,
        [employeeId],
      );
      previousPrimary = normalizeAssignment(primaryRows[0]);

      if (previousPrimary) {
        await connection.execute(
          `UPDATE employee_branch_assignments
           SET is_primary = 0
           WHERE assignment_id = ?`,
          [previousPrimary.assignmentId],
        );
      }
    }

    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id,
         branch_id,
         job_title,
         started_on,
         is_primary
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        employeeId,
        input.branchId,
        input.jobTitle,
        input.startedOn,
        effectiveIsPrimary ? 1 : 0,
      ],
    );
    const assignmentId = await getLastInsertId(connection);
    const assignment = await selectAssignment(
      connection,
      employeeId,
      assignmentId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId: input.branchId,
      actionType: 'EMPLOYEE_BRANCH_ASSIGNED',
      entityType: 'employee_branch_assignments',
      entityRecordId: assignmentId,
      beforeValues: null,
      afterValues: assignmentAuditSnapshot(assignment),
      notes: 'Employee assigned to a branch through the administration API.',
    });

    if (effectiveIsPrimary) {
      await insertAuditLog(connection, {
        auditContext,
        branchId: input.branchId,
        actionType: 'EMPLOYEE_PRIMARY_BRANCH_CHANGED',
        entityType: 'employees',
        entityRecordId: employeeId,
        beforeValues: previousPrimary
          ? {
              assignmentId: previousPrimary.assignmentId,
              branchId: previousPrimary.branchId,
            }
          : null,
        afterValues: {
          assignmentId,
          branchId: input.branchId,
        },
        notes: 'Primary branch changed while creating an assignment.',
      });
    }

    return { outcome: 'created', assignment };
  });
}

async function endAssignmentRecord(
  employeeId,
  assignmentId,
  endedOn,
  auditContext,
) {
  return withTransaction(async (connection) => {
    const employee = await selectEmployee(connection, employeeId, {
      forUpdate: true,
    });

    if (!employee) {
      return { outcome: 'employee_not_found' };
    }

    const assignment = await selectAssignment(
      connection,
      employeeId,
      assignmentId,
      { forUpdate: true },
    );

    if (!assignment) {
      return { outcome: 'assignment_not_found' };
    }

    if (assignment.endedOn !== null) {
      return assignment.endedOn === endedOn
        ? { outcome: 'unchanged', assignment }
        : { outcome: 'already_ended' };
    }

    if (endedOn < assignment.startedOn) {
      return { outcome: 'before_start_date' };
    }

    const currentDate = await selectCurrentDate(connection);

    if (endedOn > currentDate) {
      return { outcome: 'future_end_date' };
    }

    await connection.execute(
      `UPDATE employee_branch_assignments
       SET ended_on = ?, is_primary = 0
       WHERE assignment_id = ?`,
      [endedOn, assignmentId],
    );
    const endedAssignment = await selectAssignment(
      connection,
      employeeId,
      assignmentId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId: assignment.branchId,
      actionType: 'EMPLOYEE_BRANCH_ASSIGNMENT_ENDED',
      entityType: 'employee_branch_assignments',
      entityRecordId: assignmentId,
      beforeValues: assignmentAuditSnapshot(assignment),
      afterValues: assignmentAuditSnapshot(endedAssignment),
      notes: 'Employee branch assignment ended through the administration API.',
    });

    return { outcome: 'ended', assignment: endedAssignment };
  });
}

async function makeAssignmentPrimaryRecord(
  employeeId,
  assignmentId,
  auditContext,
) {
  return withTransaction(async (connection) => {
    const employee = await selectEmployee(connection, employeeId, {
      forUpdate: true,
    });

    if (!employee) {
      return { outcome: 'employee_not_found' };
    }

    if (employee.employmentStatus === 'TERMINATED') {
      return { outcome: 'employee_terminated' };
    }

    const assignment = await selectAssignment(
      connection,
      employeeId,
      assignmentId,
      { forUpdate: true },
    );

    if (!assignment) {
      return { outcome: 'assignment_not_found' };
    }

    if (assignment.endedOn !== null) {
      return { outcome: 'assignment_ended' };
    }

    const currentDate = await selectCurrentDate(connection);

    if (assignment.startedOn > currentDate) {
      return { outcome: 'assignment_not_started' };
    }

    if (assignment.branchStatus !== 'ACTIVE') {
      return { outcome: 'branch_not_active' };
    }

    if (assignment.isPrimary) {
      return { outcome: 'unchanged', assignment };
    }

    const [primaryRows] = await connection.execute(
      `SELECT ${ASSIGNMENT_COLUMNS}
       FROM employee_branch_assignments eba
       INNER JOIN branches b ON b.branch_id = eba.branch_id
       WHERE eba.employee_id = ? AND eba.is_primary = 1
       FOR UPDATE`,
      [employeeId],
    );
    const priorPrimaries = primaryRows.map(normalizeAssignment);

    await connection.execute(
      `UPDATE employee_branch_assignments
       SET is_primary = 0
       WHERE employee_id = ? AND is_primary = 1`,
      [employeeId],
    );
    await connection.execute(
      `UPDATE employee_branch_assignments
       SET is_primary = 1
       WHERE assignment_id = ?`,
      [assignmentId],
    );
    const primaryAssignment = await selectAssignment(
      connection,
      employeeId,
      assignmentId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId: assignment.branchId,
      actionType: 'EMPLOYEE_PRIMARY_BRANCH_CHANGED',
      entityType: 'employees',
      entityRecordId: employeeId,
      beforeValues: {
        assignments: priorPrimaries.map((priorAssignment) => ({
          assignmentId: priorAssignment.assignmentId,
          branchId: priorAssignment.branchId,
        })),
      },
      afterValues: {
        assignmentId,
        branchId: assignment.branchId,
      },
      notes: 'Primary employee branch changed through the administration API.',
    });

    return { outcome: 'updated', assignment: primaryAssignment };
  });
}

export {
  createAssignmentRecord,
  createEmployeeRecord,
  endAssignmentRecord,
  findAssignmentsByEmployeeId,
  findEmployeeById,
  formatEmployeeNumber,
  listEmployees,
  makeAssignmentPrimaryRecord,
  terminateEmployeeRecord,
  updateEmployeeRecord,
};

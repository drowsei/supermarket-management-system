import { randomUUID } from 'node:crypto';

import pool from '../config/database.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const MAX_MONEY_SCALED = 10n ** 19n - 1n;
const ACTIVE_SESSION_STATUSES = new Set(['OPEN', 'SUSPENDED']);

const SESSION_COLUMNS = `
  CAST(ts.till_session_id AS CHAR) AS tillSessionId,
  ts.session_number AS sessionNumber,
  CAST(ts.branch_id AS CHAR) AS branchId,
  CAST(ts.pos_register_id AS CHAR) AS posRegisterId,
  CAST(ts.cashier_employee_id AS CHAR) AS cashierEmployeeId,
  CAST(ts.opened_by_employee_id AS CHAR) AS openedByEmployeeId,
  CAST(ts.closed_by_employee_id AS CHAR) AS closedByEmployeeId,
  ts.status,
  DATE_FORMAT(ts.opened_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS openedAt,
  DATE_FORMAT(ts.closed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS closedAt,
  ts.currency_code AS currencyCode,
  ts.opening_cash_amount AS openingCashAmount,
  ts.expected_closing_cash_amount AS expectedClosingCashAmount,
  ts.actual_closing_cash_amount AS actualClosingCashAmount,
  ts.cash_difference_amount AS cashDifferenceAmount,
  ts.notes,
  DATE_FORMAT(ts.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(ts.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

const MOVEMENT_COLUMNS = `
  CAST(tcm.till_cash_movement_id AS CHAR) AS tillCashMovementId,
  CAST(tcm.till_session_id AS CHAR) AS tillSessionId,
  tcm.movement_type AS movementType,
  tcm.amount,
  tcm.reason,
  tcm.reference_number AS referenceNumber,
  CAST(tcm.recorded_by_employee_id AS CHAR) AS recordedByEmployeeId,
  DATE_FORMAT(tcm.occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
  DATE_FORMAT(tcm.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt
`;

function isDuplicateEntry(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function duplicateDiagnostic(error) {
  return `${error?.message ?? ''} ${error?.sqlMessage ?? ''}`;
}

function classifySessionDuplicate(error) {
  if (!isDuplicateEntry(error)) return null;

  const diagnostic = duplicateDiagnostic(error);
  if (diagnostic.includes('uq_till_sessions_number')) {
    return 'session_number_conflict';
  }
  if (diagnostic.includes('uq_till_sessions_active_register')) {
    return 'register_in_use';
  }
  if (diagnostic.includes('uq_till_sessions_active_cashier')) {
    return 'cashier_in_use';
  }
  return 'session_conflict';
}

function classifyMovementDuplicate(error) {
  if (!isDuplicateEntry(error)) return null;
  return duplicateDiagnostic(error).includes('uq_till_cash_movements_reference')
    ? 'duplicate_reference'
    : 'movement_conflict';
}

function uniqueSortedIds(ids) {
  return [...new Set(ids.filter(Boolean))].sort((left, right) => {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function parseScaledMoney(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Money values must be decimal strings.');
  }

  const match = value.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new TypeError('Invalid money representation.');

  const magnitude = BigInt(
    `${match[2].replace(/^0+(?=\d)/, '')}${(match[3] ?? '').padEnd(2, '0')}`,
  );

  return match[1] === '-' ? -magnitude : magnitude;
}

function formatScaledMoney(value) {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(3, '0');

  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function tillSessionSnapshot(session) {
  return {
    tillSessionId: session.tillSessionId,
    sessionNumber: session.sessionNumber,
    branchId: session.branchId,
    posRegisterId: session.posRegisterId,
    cashierEmployeeId: session.cashierEmployeeId,
    openedByEmployeeId: session.openedByEmployeeId,
    closedByEmployeeId: session.closedByEmployeeId,
    status: session.status,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    currencyCode: session.currencyCode,
    openingCashAmount: session.openingCashAmount,
    expectedClosingCashAmount: session.expectedClosingCashAmount,
    actualClosingCashAmount: session.actualClosingCashAmount,
    cashDifferenceAmount: session.cashDifferenceAmount,
    notes: session.notes,
  };
}

function movementSnapshot(movement) {
  return {
    tillCashMovementId: movement.tillCashMovementId,
    tillSessionId: movement.tillSessionId,
    movementType: movement.movementType,
    amount: movement.amount,
    reason: movement.reason,
    referenceNumber: movement.referenceNumber,
    recordedByEmployeeId: movement.recordedByEmployeeId,
    occurredAt: movement.occurredAt,
  };
}

function addDateRange(predicates, parameters, column, { from, to }) {
  if (from) {
    predicates.push(`${column} >= ?`);
    parameters.push(`${from} 00:00:00`);
  }

  if (to) {
    if (to === '9999-12-31') {
      predicates.push(`${column} <= ?`);
      parameters.push('9999-12-31 23:59:59.999999');
    } else {
      predicates.push(`${column} < DATE_ADD(?, INTERVAL 1 DAY)`);
      parameters.push(`${to} 00:00:00`);
    }
  }
}

async function selectSession(
  executor,
  branchId,
  tillSessionId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${SESSION_COLUMNS}
     FROM till_sessions ts
     WHERE ts.branch_id = ?
       AND ts.till_session_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, tillSessionId],
  );

  return rows[0] ?? null;
}

async function preReadSession(branchId, tillSessionId) {
  const [rows] = await pool.execute(
    `SELECT CAST(pos_register_id AS CHAR) AS posRegisterId
     FROM till_sessions
     WHERE branch_id = ?
       AND till_session_id = ?
     LIMIT 1`,
    [branchId, tillSessionId],
  );

  return rows[0] ?? null;
}

async function lockEmployees(connection, employeeIds) {
  const sortedIds = uniqueSortedIds(employeeIds);
  if (sortedIds.length === 0) return new Map();

  const placeholders = sortedIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT
       CAST(employee_id AS CHAR) AS employeeId,
       employment_status AS employmentStatus
     FROM employees
     WHERE employee_id IN (${placeholders})
     ORDER BY employee_id
     FOR UPDATE`,
    sortedIds,
  );

  return new Map(rows.map((row) => [row.employeeId, row]));
}

async function lockBranch(connection, branchId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(branch_id AS CHAR) AS branchId,
       status,
       currency_code AS currencyCode
     FROM branches
     WHERE branch_id = ?
     LIMIT 1
     FOR UPDATE`,
    [branchId],
  );

  return rows[0] ?? null;
}

async function lockCurrentAssignments(connection, branchId, employeeIds) {
  const assignments = new Map();

  for (const employeeId of uniqueSortedIds(employeeIds)) {
    const [rows] = await connection.execute(
      `SELECT CAST(assignment_id AS CHAR) AS assignmentId
       FROM employee_branch_assignments
       WHERE employee_id = ?
         AND branch_id = ?
         AND started_on <= CURRENT_DATE()
         AND (ended_on IS NULL OR ended_on >= CURRENT_DATE())
       ORDER BY assignment_id
       FOR UPDATE`,
      [employeeId, branchId],
    );
    assignments.set(employeeId, rows);
  }

  return assignments;
}

async function lockOperationalContext(
  connection,
  branchId,
  actorEmployeeId,
  { cashierEmployeeId = null, requireActiveBranch = false } = {},
) {
  if (!actorEmployeeId) return { outcome: 'actor_required' };

  const employeeIds = [actorEmployeeId, cashierEmployeeId].filter(Boolean);
  const employees = await lockEmployees(connection, employeeIds);
  const actor = employees.get(actorEmployeeId);

  if (!actor || actor.employmentStatus !== 'ACTIVE') {
    return { outcome: 'actor_not_active' };
  }

  if (cashierEmployeeId) {
    const cashier = employees.get(cashierEmployeeId);
    if (!cashier) return { outcome: 'cashier_not_found' };
    if (cashier.employmentStatus !== 'ACTIVE') {
      return { outcome: 'cashier_not_active' };
    }
  }

  const branch = await lockBranch(connection, branchId);
  if (!branch) return { outcome: 'branch_not_found' };
  if (requireActiveBranch && branch.status !== 'ACTIVE') {
    return { outcome: 'branch_not_active' };
  }

  const assignments = await lockCurrentAssignments(
    connection,
    branchId,
    employeeIds,
  );
  if ((assignments.get(actorEmployeeId) ?? []).length === 0) {
    return { outcome: 'actor_not_assigned' };
  }
  if (
    cashierEmployeeId &&
    (assignments.get(cashierEmployeeId) ?? []).length === 0
  ) {
    return { outcome: 'cashier_not_assigned' };
  }

  return { outcome: 'valid', branch };
}

async function lockRegister(connection, branchId, posRegisterId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(pos_register_id AS CHAR) AS posRegisterId,
       CAST(branch_id AS CHAR) AS branchId,
       status
     FROM pos_registers
     WHERE branch_id = ?
       AND pos_register_id = ?
     LIMIT 1
     FOR UPDATE`,
    [branchId, posRegisterId],
  );

  return rows[0] ?? null;
}

async function selectMovement(executor, tillCashMovementId) {
  const [rows] = await executor.execute(
    `SELECT ${MOVEMENT_COLUMNS}
     FROM till_cash_movements tcm
     WHERE tcm.till_cash_movement_id = ?
     LIMIT 1`,
    [tillCashMovementId],
  );

  return rows[0] ?? null;
}

async function listTillSessions(
  branchId,
  {
    status = null,
    posRegisterId = null,
    cashierEmployeeId = null,
    openedByEmployeeId = null,
    closedByEmployeeId = null,
    from = null,
    to = null,
    limit,
    offset,
  },
) {
  const predicates = ['ts.branch_id = ?'];
  const parameters = [branchId];
  const filters = [
    [status, 'ts.status'],
    [posRegisterId, 'ts.pos_register_id'],
    [cashierEmployeeId, 'ts.cashier_employee_id'],
    [openedByEmployeeId, 'ts.opened_by_employee_id'],
    [closedByEmployeeId, 'ts.closed_by_employee_id'],
  ];

  for (const [value, column] of filters) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(value);
    }
  }
  addDateRange(predicates, parameters, 'ts.opened_at', { from, to });

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM till_sessions ts
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${SESSION_COLUMNS}
     FROM till_sessions ts
     ${whereClause}
     ORDER BY ts.opened_at DESC, ts.till_session_id DESC
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'till session'),
  };
}

async function findTillSession(branchId, tillSessionId) {
  return selectSession(pool, branchId, tillSessionId);
}

function generateSessionNumber() {
  return `TILL-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

async function openTillSession(
  branchId,
  posRegisterId,
  values,
  auditContext,
) {
  return withCatalogTransaction(async (connection) => {
    const context = await lockOperationalContext(
      connection,
      branchId,
      auditContext?.actorEmployeeId,
      {
        cashierEmployeeId: values.cashierEmployeeId,
        requireActiveBranch: true,
      },
    );
    if (context.outcome !== 'valid') return context;

    const register = await lockRegister(connection, branchId, posRegisterId);
    if (!register) return { outcome: 'register_not_found' };
    if (register.status !== 'ACTIVE') {
      return { outcome: 'register_not_active' };
    }

    const [activeRegisterRows] = await connection.execute(
      `SELECT till_session_id
       FROM till_sessions
       WHERE active_register_guard = ?
       LIMIT 1
       FOR UPDATE`,
      [posRegisterId],
    );
    if (activeRegisterRows.length > 0) {
      return { outcome: 'register_in_use' };
    }

    const [activeCashierRows] = await connection.execute(
      `SELECT till_session_id
       FROM till_sessions
       WHERE active_cashier_guard = ?
       LIMIT 1
       FOR UPDATE`,
      [values.cashierEmployeeId],
    );
    if (activeCashierRows.length > 0) {
      return { outcome: 'cashier_in_use' };
    }

    let tillSessionId = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await connection.execute(
          `INSERT INTO till_sessions (
             session_number,
             branch_id,
             pos_register_id,
             cashier_employee_id,
             opened_by_employee_id,
             status,
             opened_at,
             currency_code,
             opening_cash_amount,
             notes
           ) VALUES (?, ?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP(6), ?, ?, ?)`,
          [
            generateSessionNumber(),
            branchId,
            posRegisterId,
            values.cashierEmployeeId,
            auditContext.actorEmployeeId,
            context.branch.currencyCode,
            values.openingCashAmount,
            values.notes,
          ],
        );
        tillSessionId = await getLastInsertId(connection);
        break;
      } catch (error) {
        const outcome = classifySessionDuplicate(error);
        if (outcome === 'session_number_conflict') continue;
        if (outcome) return { outcome };
        throw error;
      }
    }

    if (tillSessionId === null) {
      return { outcome: 'session_number_conflict' };
    }

    const tillSession = await selectSession(
      connection,
      branchId,
      tillSessionId,
    );
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'TILL_SESSION_OPENED',
      entityType: 'till_sessions',
      entityRecordId: tillSessionId,
      beforeValues: null,
      afterValues: tillSessionSnapshot(tillSession),
      notes: 'Till session opened through the till administration API.',
    });

    return { outcome: 'opened', tillSession };
  });
}

async function withLockedOperationalSession(
  branchId,
  tillSessionId,
  auditContext,
  work,
) {
  const preRead = await preReadSession(branchId, tillSessionId);
  if (!preRead) return { outcome: 'not_found' };

  return withCatalogTransaction(async (connection) => {
    const context = await lockOperationalContext(
      connection,
      branchId,
      auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;

    const register = await lockRegister(
      connection,
      branchId,
      preRead.posRegisterId,
    );
    if (!register) return { outcome: 'not_found' };

    const tillSession = await selectSession(
      connection,
      branchId,
      tillSessionId,
      { forUpdate: true },
    );
    if (
      !tillSession ||
      tillSession.posRegisterId !== preRead.posRegisterId
    ) {
      return { outcome: 'not_found' };
    }

    return work(connection, tillSession);
  });
}

async function transitionTillSession(
  branchId,
  tillSessionId,
  expectedStatus,
  nextStatus,
  actionType,
  outcome,
  auditContext,
) {
  return withLockedOperationalSession(
    branchId,
    tillSessionId,
    auditContext,
    async (connection, current) => {
      if (current.status !== expectedStatus) {
        return { outcome: 'invalid_transition' };
      }

      await connection.execute(
        `UPDATE till_sessions
         SET status = ?
         WHERE till_session_id = ?`,
        [nextStatus, tillSessionId],
      );
      const tillSession = await selectSession(
        connection,
        branchId,
        tillSessionId,
      );
      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType,
        entityType: 'till_sessions',
        entityRecordId: tillSessionId,
        beforeValues: tillSessionSnapshot(current),
        afterValues: tillSessionSnapshot(tillSession),
        notes: `Till session ${outcome} through the till administration API.`,
      });

      return { outcome, tillSession };
    },
  );
}

async function suspendTillSession(branchId, tillSessionId, auditContext) {
  return transitionTillSession(
    branchId,
    tillSessionId,
    'OPEN',
    'SUSPENDED',
    'TILL_SESSION_SUSPENDED',
    'suspended',
    auditContext,
  );
}

async function resumeTillSession(branchId, tillSessionId, auditContext) {
  return transitionTillSession(
    branchId,
    tillSessionId,
    'SUSPENDED',
    'OPEN',
    'TILL_SESSION_RESUMED',
    'resumed',
    auditContext,
  );
}

async function lockMovements(connection, tillSessionId) {
  const [rows] = await connection.execute(
    `SELECT ${MOVEMENT_COLUMNS}
     FROM till_cash_movements tcm
     WHERE tcm.till_session_id = ?
     ORDER BY tcm.till_cash_movement_id
     FOR UPDATE`,
    [tillSessionId],
  );

  return rows;
}

async function lockSales(connection, branchId, tillSessionId) {
  const [rows] = await connection.execute(
    `SELECT CAST(s.sale_id AS CHAR) AS saleId
     FROM sales s
     WHERE s.branch_id = ?
       AND s.till_session_id = ?
     ORDER BY s.sale_id
     FOR UPDATE`,
    [branchId, tillSessionId],
  );

  return rows;
}

async function lockSalePayments(connection, saleIds) {
  const sortedIds = uniqueSortedIds(saleIds);
  if (sortedIds.length === 0) return [];

  const placeholders = sortedIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT
       CAST(sp.sale_payment_id AS CHAR) AS salePaymentId,
       CAST(sp.sale_id AS CHAR) AS saleId,
       CAST(sp.payment_method_id AS CHAR) AS paymentMethodId,
       sp.payment_type AS paymentType,
       sp.status,
       sp.amount,
       sp.currency_code AS currencyCode
     FROM sale_payments sp
     WHERE sp.sale_id IN (${placeholders})
     ORDER BY sp.sale_id, sp.sale_payment_id
     FOR UPDATE`,
    sortedIds,
  );

  return rows;
}

async function lockPaymentMethods(connection, paymentMethodIds) {
  const sortedIds = uniqueSortedIds(paymentMethodIds);
  if (sortedIds.length === 0) return new Map();

  const placeholders = sortedIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT
       CAST(payment_method_id AS CHAR) AS paymentMethodId,
       method_type AS methodType
     FROM payment_methods
     WHERE payment_method_id IN (${placeholders})
     ORDER BY payment_method_id
     FOR UPDATE`,
    sortedIds,
  );

  return new Map(rows.map((row) => [row.paymentMethodId, row]));
}

function calculateExpectedCash(tillSession, movements, payments, methods) {
  let expected = parseScaledMoney(tillSession.openingCashAmount);

  for (const payment of payments) {
    if (payment.status !== 'COMPLETED') continue;
    if (methods.get(payment.paymentMethodId)?.methodType !== 'CASH') continue;

    if (payment.currencyCode !== tillSession.currencyCode) {
      return { outcome: 'currency_mismatch' };
    }

    const amount = parseScaledMoney(payment.amount);
    expected += payment.paymentType === 'REFUND' ? -amount : amount;
  }

  for (const movement of movements) {
    const amount = parseScaledMoney(movement.amount);
    expected += movement.movementType === 'CASH_IN' ? amount : -amount;
  }

  if (expected < 0n) return { outcome: 'negative_expected_cash' };
  if (expected > MAX_MONEY_SCALED) {
    return { outcome: 'reconciliation_overflow' };
  }

  return { outcome: 'calculated', expected };
}

async function closeTillSession(
  branchId,
  tillSessionId,
  actualClosingCashAmount,
  auditContext,
) {
  return withLockedOperationalSession(
    branchId,
    tillSessionId,
    auditContext,
    async (connection, current) => {
      if (!ACTIVE_SESSION_STATUSES.has(current.status)) {
        return { outcome: 'invalid_transition' };
      }

      const movements = await lockMovements(connection, tillSessionId);
      const sales = await lockSales(connection, branchId, tillSessionId);
      const payments = await lockSalePayments(
        connection,
        sales.map((sale) => sale.saleId),
      );
      const methods = await lockPaymentMethods(
        connection,
        payments.map((payment) => payment.paymentMethodId),
      );
      const calculation = calculateExpectedCash(
        current,
        movements,
        payments,
        methods,
      );
      if (calculation.outcome !== 'calculated') return calculation;

      const actual = parseScaledMoney(actualClosingCashAmount);
      if (actual < 0n || actual > MAX_MONEY_SCALED) {
        return { outcome: 'actual_cash_out_of_range' };
      }
      const expected = calculation.expected;
      const difference = actual - expected;

      await connection.execute(
        `UPDATE till_sessions
         SET status = 'CLOSED',
             closed_at = UTC_TIMESTAMP(6),
             closed_by_employee_id = ?,
             expected_closing_cash_amount = ?,
             actual_closing_cash_amount = ?,
             cash_difference_amount = ?
         WHERE till_session_id = ?`,
        [
          auditContext.actorEmployeeId,
          formatScaledMoney(expected),
          formatScaledMoney(actual),
          formatScaledMoney(difference),
          tillSessionId,
        ],
      );
      const tillSession = await selectSession(
        connection,
        branchId,
        tillSessionId,
      );
      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'TILL_SESSION_CLOSED',
        entityType: 'till_sessions',
        entityRecordId: tillSessionId,
        beforeValues: tillSessionSnapshot(current),
        afterValues: tillSessionSnapshot(tillSession),
        notes: 'Till session closed through the till administration API.',
      });

      return { outcome: 'closed', tillSession };
    },
  );
}

async function cancelTillSession(branchId, tillSessionId, auditContext) {
  return withLockedOperationalSession(
    branchId,
    tillSessionId,
    auditContext,
    async (connection, current) => {
      if (!ACTIVE_SESSION_STATUSES.has(current.status)) {
        return { outcome: 'invalid_transition' };
      }

      const movements = await lockMovements(connection, tillSessionId);
      const sales = await lockSales(connection, branchId, tillSessionId);
      if (movements.length > 0 || sales.length > 0) {
        return { outcome: 'has_activity' };
      }

      await connection.execute(
        `UPDATE till_sessions
         SET status = 'CANCELLED',
             closed_at = UTC_TIMESTAMP(6),
             closed_by_employee_id = ?,
             expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL,
             cash_difference_amount = NULL
         WHERE till_session_id = ?`,
        [auditContext.actorEmployeeId, tillSessionId],
      );
      const tillSession = await selectSession(
        connection,
        branchId,
        tillSessionId,
      );
      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'TILL_SESSION_CANCELLED',
        entityType: 'till_sessions',
        entityRecordId: tillSessionId,
        beforeValues: tillSessionSnapshot(current),
        afterValues: tillSessionSnapshot(tillSession),
        notes: 'Till session cancelled through the till administration API.',
      });

      return { outcome: 'cancelled', tillSession };
    },
  );
}

async function listCashMovements(
  branchId,
  tillSessionId,
  {
    movementType = null,
    recordedByEmployeeId = null,
    from = null,
    to = null,
    limit,
    offset,
  },
) {
  const tillSession = await selectSession(pool, branchId, tillSessionId);
  if (!tillSession) return { outcome: 'not_found' };

  const predicates = ['tcm.till_session_id = ?'];
  const parameters = [tillSessionId];
  if (movementType !== null) {
    predicates.push('tcm.movement_type = ?');
    parameters.push(movementType);
  }
  if (recordedByEmployeeId !== null) {
    predicates.push('tcm.recorded_by_employee_id = ?');
    parameters.push(recordedByEmployeeId);
  }
  addDateRange(predicates, parameters, 'tcm.occurred_at', { from, to });

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM till_cash_movements tcm
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${MOVEMENT_COLUMNS}
     FROM till_cash_movements tcm
     ${whereClause}
     ORDER BY tcm.occurred_at, tcm.till_cash_movement_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    outcome: 'listed',
    items: rows,
    totalItems: countAsSafeNumber(
      countRows[0].totalItems,
      'till cash movement',
    ),
  };
}

async function createCashMovement(
  branchId,
  tillSessionId,
  values,
  auditContext,
) {
  return withLockedOperationalSession(
    branchId,
    tillSessionId,
    auditContext,
    async (connection, tillSession) => {
      if (tillSession.status !== 'OPEN') {
        return { outcome: 'session_not_open' };
      }

      try {
        await connection.execute(
          `INSERT INTO till_cash_movements (
             till_session_id,
             movement_type,
             amount,
             reason,
             reference_number,
             recorded_by_employee_id,
             occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
          [
            tillSessionId,
            values.movementType,
            values.amount,
            values.reason,
            values.referenceNumber,
            auditContext.actorEmployeeId,
          ],
        );
      } catch (error) {
        const outcome = classifyMovementDuplicate(error);
        if (outcome) return { outcome };
        throw error;
      }

      const tillCashMovementId = await getLastInsertId(connection);
      const movement = await selectMovement(
        connection,
        tillCashMovementId,
      );
      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'TILL_CASH_MOVEMENT_CREATED',
        entityType: 'till_cash_movements',
        entityRecordId: tillCashMovementId,
        beforeValues: null,
        afterValues: movementSnapshot(movement),
        notes: 'Till cash movement recorded through the till administration API.',
      });

      return { outcome: 'created', movement };
    },
  );
}

export {
  cancelTillSession,
  closeTillSession,
  createCashMovement,
  findTillSession,
  listCashMovements,
  listTillSessions,
  openTillSession,
  resumeTillSession,
  suspendTillSession,
};

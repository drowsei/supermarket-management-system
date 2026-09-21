import pool from '../config/database.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const REGISTER_COLUMNS = `
  CAST(pr.pos_register_id AS CHAR) AS posRegisterId,
  CAST(pr.branch_id AS CHAR) AS branchId,
  pr.register_code AS registerCode,
  pr.register_name AS registerName,
  pr.terminal_identifier AS terminalIdentifier,
  pr.status,
  DATE_FORMAT(pr.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(pr.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

const REGISTER_UPDATE_COLUMNS = Object.freeze({
  registerCode: 'register_code',
  registerName: 'register_name',
  terminalIdentifier: 'terminal_identifier',
  status: 'status',
});

function registerSnapshot(register) {
  return {
    posRegisterId: register.posRegisterId,
    branchId: register.branchId,
    registerCode: register.registerCode,
    registerName: register.registerName,
    terminalIdentifier: register.terminalIdentifier,
    status: register.status,
  };
}

function isDuplicateEntry(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function classifyRegisterDuplicate(error) {
  if (!isDuplicateEntry(error)) return null;

  const diagnostic = `${error.message ?? ''} ${error.sqlMessage ?? ''}`;

  if (diagnostic.includes('uq_pos_registers_branch_code')) {
    return 'duplicate_code';
  }

  if (diagnostic.includes('uq_pos_registers_terminal')) {
    return 'duplicate_terminal';
  }

  return 'duplicate_register';
}

async function selectRegister(
  executor,
  branchId,
  posRegisterId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${REGISTER_COLUMNS}
     FROM pos_registers pr
     WHERE pr.branch_id = ?
       AND pr.pos_register_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, posRegisterId],
  );

  return rows[0] ?? null;
}

async function lockBranch(connection, branchId) {
  const [rows] = await connection.execute(
    `SELECT CAST(branch_id AS CHAR) AS branchId
     FROM branches
     WHERE branch_id = ?
     LIMIT 1
     FOR UPDATE`,
    [branchId],
  );

  return rows[0] ?? null;
}

async function listRegisters(
  branchId,
  { search = null, status = null, limit, offset },
) {
  const predicates = ['pr.branch_id = ?'];
  const parameters = [branchId];

  if (search !== null) {
    predicates.push(`(
      LOCATE(?, pr.register_code) > 0
      OR LOCATE(?, pr.register_name) > 0
      OR LOCATE(?, COALESCE(pr.terminal_identifier, '')) > 0
    )`);
    parameters.push(search, search, search);
  }

  if (status !== null) {
    predicates.push('pr.status = ?');
    parameters.push(status);
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM pos_registers pr
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${REGISTER_COLUMNS}
     FROM pos_registers pr
     ${whereClause}
     ORDER BY pr.register_code, pr.pos_register_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'POS register'),
  };
}

async function findRegister(branchId, posRegisterId) {
  return selectRegister(pool, branchId, posRegisterId);
}

async function createRegister(branchId, values, auditContext) {
  try {
    return await withCatalogTransaction(async (connection) => {
      const branch = await lockBranch(connection, branchId);
      if (!branch) return { outcome: 'branch_not_found' };

      await connection.execute(
        `INSERT INTO pos_registers (
           branch_id,
           register_code,
           register_name,
           terminal_identifier,
           status
         ) VALUES (?, ?, ?, ?, ?)`,
        [
          branchId,
          values.registerCode,
          values.registerName,
          values.terminalIdentifier,
          values.status ?? 'ACTIVE',
        ],
      );
      const posRegisterId = await getLastInsertId(connection);
      const register = await selectRegister(
        connection,
        branchId,
        posRegisterId,
      );

      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'POS_REGISTER_CREATED',
        entityType: 'pos_registers',
        entityRecordId: posRegisterId,
        beforeValues: null,
        afterValues: registerSnapshot(register),
        notes: 'POS register created through the register administration API.',
      });

      return { outcome: 'created', register };
    });
  } catch (error) {
    const outcome = classifyRegisterDuplicate(error);
    if (outcome) return { outcome };
    throw error;
  }
}

async function updateRegister(
  branchId,
  posRegisterId,
  changes,
  auditContext,
) {
  try {
    return await withCatalogTransaction(async (connection) => {
      const branch = await lockBranch(connection, branchId);
      if (!branch) return { outcome: 'branch_not_found' };

      const current = await selectRegister(
        connection,
        branchId,
        posRegisterId,
        { forUpdate: true },
      );
      if (!current) return { outcome: 'not_found' };

      const supplied = (field) => Object.hasOwn(changes, field);
      const next = {
        registerCode: supplied('registerCode')
          ? changes.registerCode
          : current.registerCode,
        registerName: supplied('registerName')
          ? changes.registerName
          : current.registerName,
        terminalIdentifier: supplied('terminalIdentifier')
          ? changes.terminalIdentifier
          : current.terminalIdentifier,
        status: supplied('status') ? changes.status : current.status,
      };
      const effectiveChanges = Object.keys(REGISTER_UPDATE_COLUMNS)
        .filter(
          (field) => supplied(field) && next[field] !== current[field],
        )
        .map((field) => [field, next[field]]);

      if (effectiveChanges.length === 0) {
        return { outcome: 'unchanged', register: current };
      }

      if (next.status !== 'ACTIVE' && next.status !== current.status) {
        const [activeRows] = await connection.execute(
          `SELECT till_session_id
           FROM till_sessions
           WHERE active_register_guard = ?
           LIMIT 1
           FOR UPDATE`,
          [posRegisterId],
        );

        if (activeRows.length > 0) {
          return { outcome: 'active_session' };
        }
      }

      const assignments = effectiveChanges.map(
        ([field]) => `${REGISTER_UPDATE_COLUMNS[field]} = ?`,
      );
      await connection.execute(
        `UPDATE pos_registers
         SET ${assignments.join(', ')}
         WHERE pos_register_id = ?`,
        [...effectiveChanges.map(([, value]) => value), posRegisterId],
      );
      const register = await selectRegister(
        connection,
        branchId,
        posRegisterId,
      );

      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'POS_REGISTER_UPDATED',
        entityType: 'pos_registers',
        entityRecordId: posRegisterId,
        beforeValues: registerSnapshot(current),
        afterValues: registerSnapshot(register),
        notes: 'POS register updated through the register administration API.',
      });

      return { outcome: 'updated', register };
    });
  } catch (error) {
    const outcome = classifyRegisterDuplicate(error);
    if (outcome) return { outcome };
    throw error;
  }
}

export {
  createRegister,
  findRegister,
  listRegisters,
  updateRegister,
};

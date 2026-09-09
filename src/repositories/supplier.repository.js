import pool from '../config/database.js';
import { toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const SUPPLIER_COLUMNS = `
  CAST(s.supplier_id AS CHAR) AS supplierId,
  s.supplier_code AS supplierCode,
  s.supplier_name AS supplierName,
  s.contact_name AS contactName,
  s.email,
  s.phone,
  s.tax_identifier AS taxIdentifier,
  s.address_line_1 AS addressLine1,
  s.address_line_2 AS addressLine2,
  s.city,
  s.state_region AS stateRegion,
  s.postal_code AS postalCode,
  s.country_code AS countryCode,
  s.payment_terms_days AS paymentTermsDays,
  s.status,
  s.created_at AS createdAt,
  s.updated_at AS updatedAt
`;

const SUPPLIER_UPDATE_COLUMNS = Object.freeze({
  supplierCode: 'supplier_code',
  supplierName: 'supplier_name',
  contactName: 'contact_name',
  email: 'email',
  phone: 'phone',
  taxIdentifier: 'tax_identifier',
  addressLine1: 'address_line_1',
  addressLine2: 'address_line_2',
  city: 'city',
  stateRegion: 'state_region',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  paymentTermsDays: 'payment_terms_days',
  status: 'status',
});

function normalizeSupplier(row) {
  if (!row) {
    return null;
  }

  return {
    supplierId: row.supplierId,
    supplierCode: row.supplierCode,
    supplierName: row.supplierName,
    contactName: row.contactName ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    taxIdentifier: row.taxIdentifier ?? null,
    addressLine1: row.addressLine1 ?? null,
    addressLine2: row.addressLine2 ?? null,
    city: row.city ?? null,
    stateRegion: row.stateRegion ?? null,
    postalCode: row.postalCode ?? null,
    countryCode: row.countryCode ?? null,
    paymentTermsDays: row.paymentTermsDays,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function supplierAuditSnapshot(supplier) {
  return Object.fromEntries(
    Object.keys(SUPPLIER_UPDATE_COLUMNS).map((field) => [field, supplier[field]]),
  );
}

async function selectSupplier(executor, supplierId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${SUPPLIER_COLUMNS}
     FROM suppliers s
     WHERE s.supplier_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [supplierId],
  );

  return normalizeSupplier(rows[0]);
}

async function listSuppliers({ search, status, limit, offset }) {
  const predicates = [];
  const parameters = [];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(' ', s.supplier_code, s.supplier_name, s.contact_name,
        s.email, s.phone, s.tax_identifier)
    ) > 0`);
    parameters.push(search);
  }

  if (status !== null) {
    predicates.push('s.status = ?');
    parameters.push(status);
  }

  const whereClause = predicates.length
    ? `WHERE ${predicates.join(' AND ')}`
    : '';
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM suppliers s
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${SUPPLIER_COLUMNS}
     FROM suppliers s
     ${whereClause}
     ORDER BY s.supplier_name, s.supplier_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeSupplier),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'supplier'),
  };
}

async function findSupplierById(supplierId) {
  return selectSupplier(pool, supplierId);
}

async function createSupplierRecord(values, auditContext) {
  return withCatalogTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO suppliers (
         supplier_code,
         supplier_name,
         contact_name,
         email,
         phone,
         tax_identifier,
         address_line_1,
         address_line_2,
         city,
         state_region,
         postal_code,
         country_code,
         payment_terms_days,
         status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.supplierCode,
        values.supplierName,
        values.contactName,
        values.email,
        values.phone,
        values.taxIdentifier,
        values.addressLine1,
        values.addressLine2,
        values.city,
        values.stateRegion,
        values.postalCode,
        values.countryCode,
        values.paymentTermsDays,
        values.status,
      ],
    );
    const supplierId = await getLastInsertId(connection);
    const supplier = await selectSupplier(connection, supplierId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'SUPPLIER_CREATED',
      entityType: 'suppliers',
      entityRecordId: supplierId,
      beforeValues: null,
      afterValues: supplierAuditSnapshot(supplier),
      notes: 'Supplier created through the supplier administration API.',
    });

    return supplier;
  });
}

async function updateSupplierRecord(supplierId, changes, auditContext) {
  return withCatalogTransaction(async (connection) => {
    const current = await selectSupplier(connection, supplierId, {
      forUpdate: true,
    });

    if (!current) {
      return { outcome: 'not_found' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => current[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', supplier: current };
    }

    const assignments = changedEntries.map(
      ([field]) => `${SUPPLIER_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([, value]) => value);

    await connection.execute(
      `UPDATE suppliers
       SET ${assignments.join(', ')}
       WHERE supplier_id = ?`,
      [...parameters, supplierId],
    );
    const supplier = await selectSupplier(connection, supplierId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'SUPPLIER_UPDATED',
      entityType: 'suppliers',
      entityRecordId: supplierId,
      beforeValues: supplierAuditSnapshot(current),
      afterValues: supplierAuditSnapshot(supplier),
      notes: 'Supplier updated through the supplier administration API.',
    });

    return { outcome: 'updated', supplier };
  });
}

export {
  createSupplierRecord,
  findSupplierById,
  listSuppliers,
  updateSupplierRecord,
};

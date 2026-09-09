import {
  createSupplierRecord,
  findSupplierById,
  listSuppliers as listSupplierRecords,
  updateSupplierRecord,
} from '../repositories/supplier.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listSuppliers(filters) {
  return listSupplierRecords(filters);
}

async function getSupplier(supplierId) {
  const supplier = await findSupplierById(supplierId);

  if (!supplier) {
    throw new HttpError(404, 'Supplier not found');
  }

  return supplier;
}

async function createSupplier(values, auditContext) {
  try {
    return await createSupplierRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier code or tax identifier already exists',
    );
  }
}

async function updateSupplier(supplierId, changes, auditContext) {
  let result;

  try {
    result = await updateSupplierRecord(supplierId, changes, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier code or tax identifier already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Supplier not found');
  }

  return result.supplier;
}

export { createSupplier, getSupplier, listSuppliers, updateSupplier };

import {
  createTaxRateRecord,
  findTaxRateById,
  listTaxRateRecords,
  updateTaxRateRecord,
} from '../repositories/taxRate.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listTaxRates(filters) {
  return listTaxRateRecords(filters);
}

async function getTaxRate(taxRateId) {
  const taxRate = await findTaxRateById(taxRateId);

  if (!taxRate) {
    throw new HttpError(404, 'Tax rate not found');
  }

  return taxRate;
}

async function createTaxRate(values, auditContext) {
  try {
    return await createTaxRateRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Tax code already exists');
  }
}

async function updateTaxRate(taxRateId, changes, auditContext) {
  let result;

  try {
    result = await updateTaxRateRecord(taxRateId, changes, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Tax code already exists');
  }

  switch (result.outcome) {
    case 'not_found':
      throw new HttpError(404, 'Tax rate not found');
    case 'active_product_dependency':
      throw new HttpError(
        409,
        'Tax rate cannot be deactivated while active products reference it',
      );
    default:
      return result.taxRate;
  }
}

export { createTaxRate, getTaxRate, listTaxRates, updateTaxRate };

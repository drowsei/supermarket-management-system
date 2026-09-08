import {
  createUnitOfMeasureRecord,
  findUnitOfMeasureById,
  listUnitOfMeasures as listUnitOfMeasureRecords,
  updateUnitOfMeasureRecord,
} from '../repositories/unitOfMeasure.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listUnitOfMeasures(filters) {
  return listUnitOfMeasureRecords(filters);
}

async function getUnitOfMeasure(unitOfMeasureId) {
  const unitOfMeasure = await findUnitOfMeasureById(unitOfMeasureId);

  if (!unitOfMeasure) {
    throw new HttpError(404, 'Unit of measure not found');
  }

  return unitOfMeasure;
}

async function createUnitOfMeasure(values, auditContext) {
  try {
    return await createUnitOfMeasureRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Unit code or unit name already exists',
    );
  }
}

async function updateUnitOfMeasure(
  unitOfMeasureId,
  changes,
  auditContext,
) {
  let result;

  try {
    result = await updateUnitOfMeasureRecord(
      unitOfMeasureId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Unit code or unit name already exists',
    );
  }

  switch (result.outcome) {
    case 'not_found':
      throw new HttpError(404, 'Unit of measure not found');
    case 'fractional_variant_dependency':
      throw new HttpError(
        409,
        'allowsFraction cannot be disabled while fractional product variants use this unit',
      );
    default:
      return result.unitOfMeasure;
  }
}

export {
  createUnitOfMeasure,
  getUnitOfMeasure,
  listUnitOfMeasures,
  updateUnitOfMeasure,
};

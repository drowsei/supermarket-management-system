import {
  createBrandRecord,
  findBrandById,
  listBrandRecords,
  updateBrandRecord,
} from '../repositories/brand.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listBrands(filters) {
  return listBrandRecords(filters);
}

async function getBrand(brandId) {
  const brand = await findBrandById(brandId);

  if (!brand) {
    throw new HttpError(404, 'Brand not found');
  }

  return brand;
}

async function createBrand(values, auditContext) {
  try {
    return await createBrandRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Brand code or brand name already exists');
  }
}

async function updateBrand(brandId, changes, auditContext) {
  let result;

  try {
    result = await updateBrandRecord(brandId, changes, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Brand code or brand name already exists');
  }

  switch (result.outcome) {
    case 'not_found':
      throw new HttpError(404, 'Brand not found');
    case 'active_product_dependency':
      throw new HttpError(
        409,
        'Brand cannot be deactivated while active products reference it',
      );
    default:
      return result.brand;
  }
}

export { createBrand, getBrand, listBrands, updateBrand };

import {
  createCategoryRecord,
  findCategoryById,
  listCategories as listCategoryRecords,
  updateCategoryRecord,
} from '../repositories/category.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwCategoryOutcomeError(outcome) {
  switch (outcome) {
    case 'parent_not_found':
      throw new HttpError(404, 'Parent category not found');
    case 'hierarchy_cycle':
      throw new HttpError(
        409,
        'The requested parent would create a category hierarchy cycle',
      );
    case 'inactive_parent':
      throw new HttpError(
        409,
        'An active category requires an active parent category',
      );
    case 'active_descendant_dependency':
      throw new HttpError(
        409,
        'Category cannot be deactivated while its subtree has an active descendant category',
      );
    case 'active_product_dependency':
      throw new HttpError(
        409,
        'Category cannot be deactivated while its subtree has an active product',
      );
    default:
      throw new Error('The category repository returned an unknown outcome.');
  }
}

async function listCategories(filters) {
  return listCategoryRecords(filters);
}

async function getCategory(categoryId) {
  const category = await findCategoryById(categoryId);

  if (!category) {
    throw new HttpError(404, 'Category not found');
  }

  return category;
}

async function createCategory(values, auditContext) {
  let result;

  try {
    result = await createCategoryRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Category code or category name within this parent already exists',
    );
  }

  if (result.outcome === 'created') {
    return result.category;
  }

  return throwCategoryOutcomeError(result.outcome);
}

async function updateCategory(categoryId, changes, auditContext) {
  let result;

  try {
    result = await updateCategoryRecord(
      categoryId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Category code or category name within this parent already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Category not found');
  }

  if (result.outcome === 'updated' || result.outcome === 'unchanged') {
    return result.category;
  }

  return throwCategoryOutcomeError(result.outcome);
}

export { createCategory, getCategory, listCategories, updateCategory };

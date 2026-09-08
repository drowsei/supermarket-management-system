import {
  createCategory,
  getCategory,
  listCategories,
  updateCategory,
} from '../services/category.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCategoryId,
  validateCategoryListQuery,
  validateCreateCategory,
  validateUpdateCategory,
} from '../validators/catalog/category.validator.js';

async function listCategoryRecords(request, response) {
  const filters = validateCategoryListQuery(request.query);
  const result = await listCategories(filters);

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function getCategoryRecord(request, response) {
  const categoryId = validateCategoryId(request.params.categoryId);
  const category = await getCategory(categoryId);

  response.status(200).json({ success: true, data: { category } });
}

async function createCategoryRecord(request, response) {
  const values = validateCreateCategory(request.body);
  const category = await createCategory(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { category } });
}

async function updateCategoryRecord(request, response) {
  const categoryId = validateCategoryId(request.params.categoryId);
  const changes = validateUpdateCategory(request.body);
  const category = await updateCategory(
    categoryId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { category } });
}

export {
  createCategoryRecord,
  getCategoryRecord,
  listCategoryRecords,
  updateCategoryRecord,
};

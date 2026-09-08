import {
  createBrand,
  getBrand,
  listBrands,
  updateBrand,
} from '../services/brand.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateBrandId,
  validateBrandListQuery,
  validateCreateBrand,
  validateUpdateBrand,
} from '../validators/catalog/brand.validator.js';

async function listBrandRecords(request, response) {
  const filters = validateBrandListQuery(request.query);
  const result = await listBrands(filters);

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

async function getBrandRecord(request, response) {
  const brandId = validateBrandId(request.params.brandId);
  const brand = await getBrand(brandId);

  response.status(200).json({ success: true, data: { brand } });
}

async function createBrandRecord(request, response) {
  const values = validateCreateBrand(request.body);
  const brand = await createBrand(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { brand } });
}

async function updateBrandRecord(request, response) {
  const brandId = validateBrandId(request.params.brandId);
  const changes = validateUpdateBrand(request.body);
  const brand = await updateBrand(
    brandId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { brand } });
}

export {
  createBrandRecord,
  getBrandRecord,
  listBrandRecords,
  updateBrandRecord,
};

import {
  createProductPackage,
  getProductPackage,
  listProductPackages,
  updateProductPackage,
} from '../services/productPackage.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateProductPackageId,
  validateProductPackageListQuery,
  validateCreateProductPackage,
  validateUpdateProductPackage,
} from '../validators/products/productPackage.validator.js';
import { validateVariantId } from '../validators/products/productVariant.validator.js';

async function listProductPackageRecords(request, response) {
  const variantId = validateVariantId(request.params.variantId);
  const filters = validateProductPackageListQuery(request.query);
  const result = await listProductPackages(variantId, filters);

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

async function getProductPackageRecord(request, response) {
  const packageId = validateProductPackageId(request.params.packageId);
  const productPackage = await getProductPackage(packageId);

  response.status(200).json({
    success: true,
    data: { productPackage },
  });
}

async function createProductPackageRecord(request, response) {
  const variantId = validateVariantId(request.params.variantId);
  const values = validateCreateProductPackage(request.body);
  const productPackage = await createProductPackage(
    variantId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({
    success: true,
    data: { productPackage },
  });
}

async function updateProductPackageRecord(request, response) {
  const packageId = validateProductPackageId(request.params.packageId);
  const changes = validateUpdateProductPackage(request.body);
  const productPackage = await updateProductPackage(
    packageId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { productPackage },
  });
}

export {
  createProductPackageRecord,
  getProductPackageRecord,
  listProductPackageRecords,
  updateProductPackageRecord,
};

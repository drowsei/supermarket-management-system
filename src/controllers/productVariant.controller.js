import {
  createProductVariant,
  getProductVariant,
  listProductVariants,
  updateProductVariant,
} from '../services/productVariant.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateProductId } from '../validators/products/product.validator.js';
import {
  validateCreateProductVariant,
  validateProductVariantListQuery,
  validateUpdateProductVariant,
  validateVariantId,
} from '../validators/products/productVariant.validator.js';

async function listProductVariantRecords(request, response) {
  const productId = validateProductId(request.params.productId);
  const filters = validateProductVariantListQuery(request.query);
  const result = await listProductVariants(productId, filters);

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

async function getProductVariantRecord(request, response) {
  const variantId = validateVariantId(request.params.variantId);
  const productVariant = await getProductVariant(variantId);

  response.status(200).json({
    success: true,
    data: { productVariant },
  });
}

async function createProductVariantRecord(request, response) {
  const productId = validateProductId(request.params.productId);
  const values = validateCreateProductVariant(request.body);
  const productVariant = await createProductVariant(
    productId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({
    success: true,
    data: { productVariant },
  });
}

async function updateProductVariantRecord(request, response) {
  const variantId = validateVariantId(request.params.variantId);
  const changes = validateUpdateProductVariant(request.body);
  const productVariant = await updateProductVariant(
    variantId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { productVariant },
  });
}

export {
  createProductVariantRecord,
  getProductVariantRecord,
  listProductVariantRecords,
  updateProductVariantRecord,
};

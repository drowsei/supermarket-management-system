import {
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
} from '../services/product.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreateProduct,
  validateProductId,
  validateProductListQuery,
  validateUpdateProduct,
} from '../validators/products/product.validator.js';

async function listProductRecords(request, response) {
  const filters = validateProductListQuery(request.query);
  const result = await listProducts(filters);

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

async function getProductRecord(request, response) {
  const productId = validateProductId(request.params.productId);
  const product = await getProduct(productId);

  response.status(200).json({ success: true, data: { product } });
}

async function createProductRecord(request, response) {
  const values = validateCreateProduct(request.body);
  const product = await createProduct(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { product } });
}

async function updateProductRecord(request, response) {
  const productId = validateProductId(request.params.productId);
  const changes = validateUpdateProduct(request.body);
  const product = await updateProduct(
    productId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { product } });
}

export {
  createProductRecord,
  getProductRecord,
  listProductRecords,
  updateProductRecord,
};

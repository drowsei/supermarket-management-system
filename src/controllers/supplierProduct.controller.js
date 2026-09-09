import {
  createSupplierProduct,
  getSupplierProduct,
  listSupplierProducts,
  updateSupplierProduct,
} from '../services/supplierProduct.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoSupplierQuery } from '../validators/suppliers/common.validator.js';
import { validateSupplierId } from '../validators/suppliers/supplier.validator.js';
import {
  validateCreateSupplierProduct,
  validateSupplierProductId,
  validateSupplierProductListQuery,
  validateUpdateSupplierProduct,
} from '../validators/suppliers/supplierProduct.validator.js';

async function listSupplierProductRecords(request, response) {
  const supplierId = validateSupplierId(request.params.supplierId);
  const filters = validateSupplierProductListQuery(request.query);
  const result = await listSupplierProducts(supplierId, filters);

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

async function getSupplierProductRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplierProductId = validateSupplierProductId(
    request.params.supplierProductId,
  );
  const supplierProduct = await getSupplierProduct(
    supplierId,
    supplierProductId,
  );

  response.status(200).json({
    success: true,
    data: { supplierProduct },
  });
}

async function createSupplierProductRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const values = validateCreateSupplierProduct(request.body);
  const supplierProduct = await createSupplierProduct(
    supplierId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({
    success: true,
    data: { supplierProduct },
  });
}

async function updateSupplierProductRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplierProductId = validateSupplierProductId(
    request.params.supplierProductId,
  );
  const changes = validateUpdateSupplierProduct(request.body);
  const supplierProduct = await updateSupplierProduct(
    supplierId,
    supplierProductId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { supplierProduct },
  });
}

export {
  createSupplierProductRecord,
  getSupplierProductRecord,
  listSupplierProductRecords,
  updateSupplierProductRecord,
};

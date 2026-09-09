import {
  createSupplierProductPackage,
  getSupplierProductPackage,
  listSupplierProductPackages,
  updateSupplierProductPackage,
} from '../services/supplierProductPackage.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoSupplierQuery } from '../validators/suppliers/common.validator.js';
import { validateSupplierId } from '../validators/suppliers/supplier.validator.js';
import { validateSupplierProductId } from '../validators/suppliers/supplierProduct.validator.js';
import {
  validateCreateSupplierProductPackage,
  validateSupplierProductPackageId,
  validateSupplierProductPackageListQuery,
  validateUpdateSupplierProductPackage,
} from '../validators/suppliers/supplierProductPackage.validator.js';

async function listSupplierProductPackageRecords(request, response) {
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplierProductId = validateSupplierProductId(
    request.params.supplierProductId,
  );
  const filters = validateSupplierProductPackageListQuery(request.query);
  const result = await listSupplierProductPackages(
    supplierId,
    supplierProductId,
    filters,
  );

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

async function getSupplierProductPackageRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplierProductPackageId = validateSupplierProductPackageId(
    request.params.supplierProductPackageId,
  );
  const supplierProductPackage = await getSupplierProductPackage(
    supplierId,
    supplierProductPackageId,
  );

  response.status(200).json({
    success: true,
    data: { supplierProductPackage },
  });
}

async function createSupplierProductPackageRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplierProductId = validateSupplierProductId(
    request.params.supplierProductId,
  );
  const values = validateCreateSupplierProductPackage(request.body);
  const supplierProductPackage = await createSupplierProductPackage(
    supplierId,
    supplierProductId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({
    success: true,
    data: { supplierProductPackage },
  });
}

async function updateSupplierProductPackageRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplierProductPackageId = validateSupplierProductPackageId(
    request.params.supplierProductPackageId,
  );
  const changes = validateUpdateSupplierProductPackage(request.body);
  const supplierProductPackage = await updateSupplierProductPackage(
    supplierId,
    supplierProductPackageId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { supplierProductPackage },
  });
}

export {
  createSupplierProductPackageRecord,
  getSupplierProductPackageRecord,
  listSupplierProductPackageRecords,
  updateSupplierProductPackageRecord,
};

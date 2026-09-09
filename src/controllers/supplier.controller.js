import {
  createSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from '../services/supplier.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoSupplierQuery } from '../validators/suppliers/common.validator.js';
import {
  validateCreateSupplier,
  validateSupplierId,
  validateSupplierListQuery,
  validateUpdateSupplier,
} from '../validators/suppliers/supplier.validator.js';

async function listSupplierRecords(request, response) {
  const filters = validateSupplierListQuery(request.query);
  const result = await listSuppliers(filters);

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

async function getSupplierRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const supplier = await getSupplier(supplierId);

  response.status(200).json({ success: true, data: { supplier } });
}

async function createSupplierRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const values = validateCreateSupplier(request.body);
  const supplier = await createSupplier(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { supplier } });
}

async function updateSupplierRecord(request, response) {
  validateNoSupplierQuery(request.query);
  const supplierId = validateSupplierId(request.params.supplierId);
  const changes = validateUpdateSupplier(request.body);
  const supplier = await updateSupplier(
    supplierId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { supplier } });
}

export {
  createSupplierRecord,
  getSupplierRecord,
  listSupplierRecords,
  updateSupplierRecord,
};

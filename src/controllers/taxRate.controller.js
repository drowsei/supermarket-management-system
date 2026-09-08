import {
  createTaxRate,
  getTaxRate,
  listTaxRates,
  updateTaxRate,
} from '../services/taxRate.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreateTaxRate,
  validateTaxRateId,
  validateTaxRateListQuery,
  validateUpdateTaxRate,
} from '../validators/catalog/taxRate.validator.js';

async function listTaxRateRecords(request, response) {
  const filters = validateTaxRateListQuery(request.query);
  const result = await listTaxRates(filters);

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

async function getTaxRateRecord(request, response) {
  const taxRateId = validateTaxRateId(request.params.taxRateId);
  const taxRate = await getTaxRate(taxRateId);

  response.status(200).json({ success: true, data: { taxRate } });
}

async function createTaxRateRecord(request, response) {
  const values = validateCreateTaxRate(request.body);
  const taxRate = await createTaxRate(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { taxRate } });
}

async function updateTaxRateRecord(request, response) {
  const taxRateId = validateTaxRateId(request.params.taxRateId);
  const changes = validateUpdateTaxRate(request.body);
  const taxRate = await updateTaxRate(
    taxRateId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { taxRate } });
}

export {
  createTaxRateRecord,
  getTaxRateRecord,
  listTaxRateRecords,
  updateTaxRateRecord,
};

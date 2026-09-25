import * as service from '../services/sale.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreateSale,
  validateSaleId,
  validateSaleListQuery,
  validateSalesTillSessionId,
  validateUpdateSale,
} from '../validators/sales/sale.validator.js';
import {
  validateCreateSaleItem,
  validateSaleItemId,
  validateUpdateSaleItem,
} from '../validators/sales/saleItem.validator.js';
import { validateEmptyBody, validateNoQuery } from '../validators/sales/common.validator.js';

const branchId = (request) => request.salesBranch.branchId;
const saleId = (request) => validateSaleId(request.params.saleId);

async function listSaleRecords(request, response) {
  const filters = validateSaleListQuery(request.query);
  const result = await service.listSales(branchId(request), filters);
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
    },
  });
}

async function createSaleRecord(request, response) {
  validateNoQuery(request.query);
  const sale = await service.createSale(
    branchId(request),
    validateSalesTillSessionId(request.params.tillSessionId),
    validateCreateSale(request.body),
    getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { sale } });
}

async function getSaleRecord(request, response) {
  validateNoQuery(request.query);
  const sale = await service.getSale(branchId(request), saleId(request));
  response.status(200).json({ success: true, data: { sale } });
}

async function updateSaleRecord(request, response) {
  validateNoQuery(request.query);
  const sale = await service.updateSale(
    branchId(request), saleId(request), validateUpdateSale(request.body),
    getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { sale } });
}

async function createSaleItemRecord(request, response) {
  validateNoQuery(request.query);
  const result = await service.addSaleItem(
    branchId(request), saleId(request), validateCreateSaleItem(request.body),
    getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { item: result.item, sale: result.sale } });
}

async function updateSaleItemRecord(request, response) {
  validateNoQuery(request.query);
  const result = await service.updateSaleItem(
    branchId(request), saleId(request),
    validateSaleItemId(request.params.saleItemId),
    validateUpdateSaleItem(request.body), getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { item: result.item, sale: result.sale } });
}

async function deleteSaleItemRecord(request, response) {
  validateNoQuery(request.query);
  await service.deleteSaleItem(
    branchId(request), saleId(request),
    validateSaleItemId(request.params.saleItemId), getAuditContext(request),
  );
  response.status(204).send();
}

async function completeSaleRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const sale = await service.completeSale(
    branchId(request), saleId(request), getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { sale } });
}

async function cancelSaleRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const sale = await service.cancelSale(
    branchId(request), saleId(request), getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { sale } });
}

export {
  cancelSaleRecord,
  completeSaleRecord,
  createSaleItemRecord,
  createSaleRecord,
  deleteSaleItemRecord,
  getSaleRecord,
  listSaleRecords,
  updateSaleItemRecord,
  updateSaleRecord,
};

import {
  createSaleRefund,
  listSaleRefunds,
  transitionSaleRefund,
} from '../services/saleRefund.service.js';
import {
  completeSalesReturn,
  createSalesReturn,
  createSalesReturnItem,
  deleteSalesReturnItem,
  getSalesReturn,
  listSalesReturns,
  transitionSalesReturn,
  updateSalesReturnItem,
} from '../services/salesReturn.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateSaleId } from '../validators/sales/sale.validator.js';
import {
  parseReturnId,
  parseReturnItemId,
  validateEmptyActionBody,
  validateNoQuery,
} from '../validators/returns/common.validator.js';
import {
  validateCreateSalesReturn,
  validateCreateSalesReturnItem,
  validateSalesReturnListQuery,
  validateUpdateSalesReturnItem,
} from '../validators/returns/salesReturn.validator.js';
import {
  validateCreateSaleRefund,
  validateSaleRefundId,
  validateSaleRefundListQuery,
} from '../validators/returns/refund.validator.js';

const branchId = (request) => request.salesBranch.branchId;
const saleId = (request) => validateSaleId(request.params.saleId);
const returnId = (request) => parseReturnId(request.params.salesReturnId);
const returnItemId = (request) => parseReturnItemId(request.params.salesReturnItemId);
const refundId = (request) => validateSaleRefundId(request.params.salePaymentId);

async function listSalesReturnRecords(request, response) {
  const filters = validateSalesReturnListQuery(request.query);
  const result = await listSalesReturns(branchId(request), saleId(request), filters);
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
    },
  });
}

async function createSalesReturnRecord(request, response) {
  validateNoQuery(request.query);
  const salesReturn = await createSalesReturn(
    branchId(request), saleId(request), validateCreateSalesReturn(request.body),
    getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { salesReturn } });
}

async function getSalesReturnRecord(request, response) {
  validateNoQuery(request.query);
  const salesReturn = await getSalesReturn(
    branchId(request), saleId(request), returnId(request),
  );
  response.status(200).json({ success: true, data: { salesReturn } });
}

async function createSalesReturnItemRecord(request, response) {
  validateNoQuery(request.query);
  const result = await createSalesReturnItem(
    branchId(request), saleId(request), returnId(request),
    validateCreateSalesReturnItem(request.body), getAuditContext(request),
  );
  response.status(201).json({ success: true, data: result });
}

async function updateSalesReturnItemRecord(request, response) {
  validateNoQuery(request.query);
  const result = await updateSalesReturnItem(
    branchId(request), saleId(request), returnId(request), returnItemId(request),
    validateUpdateSalesReturnItem(request.body), getAuditContext(request),
  );
  response.status(200).json({ success: true, data: result });
}

async function deleteSalesReturnItemRecord(request, response) {
  validateNoQuery(request.query);
  await deleteSalesReturnItem(
    branchId(request), saleId(request), returnId(request), returnItemId(request),
    getAuditContext(request),
  );
  response.status(204).send();
}

async function actOnReturn(request, response, action) {
  validateNoQuery(request.query);
  validateEmptyActionBody(request.body);
  const salesReturn = action === 'COMPLETED'
    ? await completeSalesReturn(
      branchId(request), saleId(request), returnId(request), getAuditContext(request),
    )
    : await transitionSalesReturn(
      branchId(request), saleId(request), returnId(request), action,
      getAuditContext(request),
    );
  response.status(200).json({ success: true, data: { salesReturn } });
}

const submitSalesReturnRecord = (request, response) =>
  actOnReturn(request, response, 'SUBMITTED');
const approveSalesReturnRecord = (request, response) =>
  actOnReturn(request, response, 'APPROVED');
const completeSalesReturnRecord = (request, response) =>
  actOnReturn(request, response, 'COMPLETED');
const cancelSalesReturnRecord = (request, response) =>
  actOnReturn(request, response, 'CANCELLED');

async function listSaleRefundRecords(request, response) {
  const filters = validateSaleRefundListQuery(request.query);
  const result = await listSaleRefunds(
    branchId(request), saleId(request), returnId(request), filters,
  );
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
      summary: result.summary,
    },
  });
}

async function createSaleRefundRecord(request, response) {
  validateNoQuery(request.query);
  const payment = await createSaleRefund(
    branchId(request), saleId(request), returnId(request),
    validateCreateSaleRefund(request.body), getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { payment } });
}

async function actOnRefund(request, response, transition) {
  validateNoQuery(request.query);
  validateEmptyActionBody(request.body);
  const payment = await transitionSaleRefund(
    branchId(request), saleId(request), returnId(request), refundId(request),
    transition, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { payment } });
}

const completeSaleRefundRecord = (request, response) =>
  actOnRefund(request, response, 'COMPLETED');
const failSaleRefundRecord = (request, response) =>
  actOnRefund(request, response, 'FAILED');
const cancelSaleRefundRecord = (request, response) =>
  actOnRefund(request, response, 'CANCELLED');

export {
  approveSalesReturnRecord,
  cancelSaleRefundRecord,
  cancelSalesReturnRecord,
  completeSaleRefundRecord,
  completeSalesReturnRecord,
  createSaleRefundRecord,
  createSalesReturnItemRecord,
  createSalesReturnRecord,
  deleteSalesReturnItemRecord,
  failSaleRefundRecord,
  getSalesReturnRecord,
  listSaleRefundRecords,
  listSalesReturnRecords,
  submitSalesReturnRecord,
  updateSalesReturnItemRecord,
};

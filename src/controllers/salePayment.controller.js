import {
  createSalePayment,
  getSalePayment,
  listSalePayments,
  transitionSalePayment,
} from '../services/salePayment.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateSaleId } from '../validators/sales/sale.validator.js';
import {
  validateCreateSalePayment,
  validateSalePaymentId,
  validateSalePaymentListQuery,
} from '../validators/payments/salePayment.validator.js';
import {
  validateEmptyActionBody,
  validateNoQuery,
} from '../validators/payments/common.validator.js';

const branchId = (request) => request.salesBranch.branchId;
const saleId = (request) => validateSaleId(request.params.saleId);
const paymentId = (request) => validateSalePaymentId(request.params.salePaymentId);

async function listSalePaymentRecords(request, response) {
  const filters = validateSalePaymentListQuery(request.query);
  const result = await listSalePayments(branchId(request), saleId(request), filters);
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
      summary: result.summary,
    },
  });
}

async function getSalePaymentRecord(request, response) {
  validateNoQuery(request.query);
  const payment = await getSalePayment(
    branchId(request), saleId(request), paymentId(request),
  );
  response.status(200).json({ success: true, data: { payment } });
}

async function createSalePaymentRecord(request, response) {
  validateNoQuery(request.query);
  const payment = await createSalePayment(
    branchId(request),
    saleId(request),
    validateCreateSalePayment(request.body),
    getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { payment } });
}

async function actOnPayment(request, response, transition) {
  validateNoQuery(request.query);
  validateEmptyActionBody(request.body);
  const payment = await transitionSalePayment(
    branchId(request),
    saleId(request),
    paymentId(request),
    transition,
    getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { payment } });
}

const completeSalePaymentRecord = (request, response) =>
  actOnPayment(request, response, 'COMPLETED');
const failSalePaymentRecord = (request, response) =>
  actOnPayment(request, response, 'FAILED');
const cancelSalePaymentRecord = (request, response) =>
  actOnPayment(request, response, 'CANCELLED');

export {
  cancelSalePaymentRecord,
  completeSalePaymentRecord,
  createSalePaymentRecord,
  failSalePaymentRecord,
  getSalePaymentRecord,
  listSalePaymentRecords,
};

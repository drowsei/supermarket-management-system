import {
  createPurchaseOrder,
  createPurchaseOrderItem,
  deletePurchaseOrderItem,
  getPurchaseOrder,
  listPurchaseOrders,
  transitionPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderItem,
} from '../services/purchaseOrder.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateEmptyBody, validateNoQuery } from '../validators/purchasing/common.validator.js';
import {
  validateCancelPurchaseOrder,
  validateCreatePurchaseOrder,
  validateCreatePurchaseOrderItem,
  validatePatchPurchaseOrder,
  validatePatchPurchaseOrderItem,
  validatePurchaseOrderId,
  validatePurchaseOrderItemId,
  validatePurchaseOrderListQuery,
} from '../validators/purchasing/purchaseOrder.validator.js';

function branchId(request) {
  return request.purchasingBranch.branchId;
}

async function listPurchaseOrderRecords(request, response) {
  const filters = validatePurchaseOrderListQuery(request.query);
  const result = await listPurchaseOrders(branchId(request), filters);
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
    },
  });
}

async function getPurchaseOrderRecord(request, response) {
  validateNoQuery(request.query);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const result = await getPurchaseOrder(branchId(request), id);
  response.status(200).json({ success: true, data: result });
}

async function createPurchaseOrderRecord(request, response) {
  validateNoQuery(request.query);
  const values = validateCreatePurchaseOrder(request.body);
  const purchaseOrder = await createPurchaseOrder(
    branchId(request), values, getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { purchaseOrder } });
}

async function updatePurchaseOrderRecord(request, response) {
  validateNoQuery(request.query);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const changes = validatePatchPurchaseOrder(request.body);
  const purchaseOrder = await updatePurchaseOrder(
    branchId(request), id, changes, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { purchaseOrder } });
}

async function createPurchaseOrderItemRecord(request, response) {
  validateNoQuery(request.query);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const values = validateCreatePurchaseOrderItem(request.body);
  const result = await createPurchaseOrderItem(
    branchId(request), id, values, getAuditContext(request),
  );
  response.status(201).json({ success: true, data: result });
}

async function updatePurchaseOrderItemRecord(request, response) {
  validateNoQuery(request.query);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const itemId = validatePurchaseOrderItemId(request.params.purchaseOrderItemId);
  const changes = validatePatchPurchaseOrderItem(request.body);
  const result = await updatePurchaseOrderItem(
    branchId(request), id, itemId, changes, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: result });
}

async function deletePurchaseOrderItemRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const itemId = validatePurchaseOrderItemId(request.params.purchaseOrderItemId);
  const result = await deletePurchaseOrderItem(
    branchId(request), id, itemId, getAuditContext(request),
  );
  response.status(200).json({
    success: true,
    data: { deletedPurchaseOrderItemId: result.item.purchaseOrderItemId, purchaseOrder: result.purchaseOrder },
  });
}

async function submitPurchaseOrderRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const purchaseOrder = await transitionPurchaseOrder(
    branchId(request), id, 'submit', null, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { purchaseOrder } });
}

async function approvePurchaseOrderRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const purchaseOrder = await transitionPurchaseOrder(
    branchId(request), id, 'approve', null, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { purchaseOrder } });
}

async function cancelPurchaseOrderRecord(request, response) {
  validateNoQuery(request.query);
  const id = validatePurchaseOrderId(request.params.purchaseOrderId);
  const { reason } = validateCancelPurchaseOrder(request.body);
  const purchaseOrder = await transitionPurchaseOrder(
    branchId(request), id, 'cancel', reason, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { purchaseOrder } });
}

export {
  approvePurchaseOrderRecord,
  cancelPurchaseOrderRecord,
  createPurchaseOrderItemRecord,
  createPurchaseOrderRecord,
  deletePurchaseOrderItemRecord,
  getPurchaseOrderRecord,
  listPurchaseOrderRecords,
  submitPurchaseOrderRecord,
  updatePurchaseOrderItemRecord,
  updatePurchaseOrderRecord,
};

import {
  cancelGoodsReceipt,
  createGoodsReceipt,
  createGoodsReceiptItem,
  deleteGoodsReceiptItem,
  getGoodsReceipt,
  listGoodsReceipts,
  postGoodsReceipt,
  updateGoodsReceipt,
  updateGoodsReceiptItem,
} from '../services/goodsReceipt.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateEmptyBody, validateNoQuery } from '../validators/purchasing/common.validator.js';
import {
  validateCreateGoodsReceipt,
  validateCreateGoodsReceiptItem,
  validateGoodsReceiptId,
  validateGoodsReceiptItemId,
  validateGoodsReceiptListQuery,
  validatePatchGoodsReceipt,
  validatePatchGoodsReceiptItem,
  validateReceiptPosting,
} from '../validators/purchasing/goodsReceipt.validator.js';

function branchId(request) {
  return request.purchasingBranch.branchId;
}

async function listGoodsReceiptRecords(request, response) {
  const filters = validateGoodsReceiptListQuery(request.query);
  const result = await listGoodsReceipts(branchId(request), filters);
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
    },
  });
}

async function getGoodsReceiptRecord(request, response) {
  validateNoQuery(request.query);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  response.status(200).json({
    success: true,
    data: await getGoodsReceipt(branchId(request), id),
  });
}

async function createGoodsReceiptRecord(request, response) {
  validateNoQuery(request.query);
  const values = validateCreateGoodsReceipt(request.body);
  const goodsReceipt = await createGoodsReceipt(
    branchId(request), values, getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { goodsReceipt } });
}

async function updateGoodsReceiptRecord(request, response) {
  validateNoQuery(request.query);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  const changes = validatePatchGoodsReceipt(request.body);
  const goodsReceipt = await updateGoodsReceipt(
    branchId(request), id, changes, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { goodsReceipt } });
}

async function createGoodsReceiptItemRecord(request, response) {
  validateNoQuery(request.query);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  const values = validateCreateGoodsReceiptItem(request.body);
  const item = await createGoodsReceiptItem(
    branchId(request), id, values, getAuditContext(request),
  );
  response.status(201).json({ success: true, data: { item } });
}

async function updateGoodsReceiptItemRecord(request, response) {
  validateNoQuery(request.query);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  const itemId = validateGoodsReceiptItemId(request.params.goodsReceiptItemId);
  const changes = validatePatchGoodsReceiptItem(request.body);
  const item = await updateGoodsReceiptItem(
    branchId(request), id, itemId, changes, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { item } });
}

async function deleteGoodsReceiptItemRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  const itemId = validateGoodsReceiptItemId(request.params.goodsReceiptItemId);
  const item = await deleteGoodsReceiptItem(
    branchId(request), id, itemId, getAuditContext(request),
  );
  response.status(200).json({
    success: true,
    data: { deletedGoodsReceiptItemId: item.goodsReceiptItemId },
  });
}

async function postGoodsReceiptRecord(request, response) {
  validateNoQuery(request.query);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  const values = validateReceiptPosting(request.body);
  const result = await postGoodsReceipt(
    branchId(request), id, values, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: result });
}

async function cancelGoodsReceiptRecord(request, response) {
  validateNoQuery(request.query);
  validateEmptyBody(request.body);
  const id = validateGoodsReceiptId(request.params.goodsReceiptId);
  const goodsReceipt = await cancelGoodsReceipt(
    branchId(request), id, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { goodsReceipt } });
}

export {
  cancelGoodsReceiptRecord,
  createGoodsReceiptItemRecord,
  createGoodsReceiptRecord,
  deleteGoodsReceiptItemRecord,
  getGoodsReceiptRecord,
  listGoodsReceiptRecords,
  postGoodsReceiptRecord,
  updateGoodsReceiptItemRecord,
  updateGoodsReceiptRecord,
};

import {
  addSaleItem as addSaleItemRecord,
  cancelSale as cancelSaleRecord,
  createSale as createSaleRecord,
  deleteSaleItem as deleteSaleItemRecord,
  findSale,
  listSales as listSaleRecords,
  updateSale as updateSaleRecord,
  updateSaleItem as updateSaleItemRecord,
} from '../repositories/sale.repository.js';
import { completeSale as completeSaleRecord } from '../repositories/saleCompletion.repository.js';
import HttpError from '../utils/httpError.js';

const OUTCOME_ERRORS = Object.freeze({
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'],
  branch_not_active: [409, 'Sales operations require an active branch'],
  cashier_not_active: [409, 'The till cashier must be an active employee'],
  cashier_not_assigned: [409, 'The till cashier has no current assignment at this branch'],
  till_not_found: [404, 'Till session not found'],
  till_not_open: [409, 'Checkout activity requires an OPEN till session'],
  till_cancelled: [409, 'A sale linked to a cancelled till session cannot be cancelled'],
  sale_not_found: [404, 'Sale not found'],
  item_not_found: [404, 'Sale item not found'],
  customer_not_found: [404, 'Customer not found'],
  customer_not_active: [409, 'The selected customer must be active'],
  barcode_not_found: [404, 'Barcode not found'],
  variant_not_found: [404, 'Product variant not found'],
  package_not_found: [404, 'Product package not found for this variant'],
  base_package_unavailable: [409, 'The product variant has no unambiguous active base package'],
  product_not_active: [409, 'The product must be active for checkout'],
  variant_not_active: [409, 'The product variant must be active for checkout'],
  package_not_active: [409, 'The product package must be active for checkout'],
  package_not_sellable: [409, 'The product package is not sellable'],
  sale_not_open: [409, 'Only an OPEN sale may perform this operation'],
  currency_mismatch: [409, 'Sale, till, and branch currencies are inconsistent'],
  concurrent_change: [409, 'Sale or related data changed concurrently; retry'],
  catalog_changed: [409, 'Sale catalog identity changed or is no longer available'],
  fractional_package_quantity: [409, 'The selected package requires a whole quantity'],
  fractional_base_quantity: [409, 'The product variant requires a whole base quantity'],
  base_quantity_zero: [409, 'The package conversion produces a zero base quantity'],
  discount_exceeds_gross: [409, 'Discount amount cannot exceed the line gross amount'],
  line_number_overflow: [409, 'The sale has reached its supported line-number limit'],
  sale_number_conflict: [409, 'A unique sale number could not be generated; please retry'],
  transaction_number_conflict: [409, 'A unique inventory transaction number could not be generated; please retry'],
  empty_sale: [409, 'A sale must contain at least one item before completion'],
  insufficient_stock: [409, 'Branch stock is insufficient to complete the sale'],
  required_lot_shortage: [409, 'Eligible lot stock is insufficient for a required-lot product'],
  lot_insufficient_stock: [409, 'Branch lot stock is insufficient to complete the sale'],
  unsafe_lot: [409, 'An allocated lot is not eligible for sale'],
  lot_consistency: [409, 'Completion would violate required-lot inventory consistency'],
  valuation_unavailable: [409, 'Current inventory valuation is unavailable'],
  valuation_history_conflict: [409, 'Inventory valuation history is inconsistent'],
  valuation_projection_conflict: [409, 'Inventory ledger and branch stock projection are inconsistent'],
  header_totals_conflict: [409, 'Sale header totals are inconsistent with persisted items'],
});

function expect(result, accepted) {
  if (accepted.includes(result.outcome)) return result;
  const error = OUTCOME_ERRORS[result.outcome];
  if (!error) throw new Error(`Unknown sales outcome: ${result.outcome}`);
  throw new HttpError(...error);
}

async function withArithmeticTranslation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (
      error?.code === 'SALES_ARITHMETIC_OVERFLOW' ||
      error?.code === 'SALES_VALUATION_OVERFLOW'
    ) {
      throw new HttpError(409, 'Sales quantity, money, or valuation exceeds the supported range');
    }
    throw error;
  }
}

async function listSales(branchId, filters) {
  return listSaleRecords(branchId, filters);
}

async function getSale(branchId, saleId) {
  const sale = await findSale(branchId, saleId);
  if (!sale) throw new HttpError(404, 'Sale not found');
  return sale;
}

async function createSale(branchId, tillSessionId, values, auditContext) {
  return withArithmeticTranslation(async () =>
    expect(await createSaleRecord(branchId, tillSessionId, values, auditContext), ['created']).sale,
  );
}

async function updateSale(branchId, saleId, values, auditContext) {
  return withArithmeticTranslation(async () =>
    expect(await updateSaleRecord(branchId, saleId, values, auditContext), ['updated', 'unchanged']).sale,
  );
}

async function addSaleItem(branchId, saleId, values, auditContext) {
  return withArithmeticTranslation(async () =>
    expect(await addSaleItemRecord(branchId, saleId, values, auditContext), ['created']),
  );
}

async function updateSaleItem(branchId, saleId, saleItemId, values, auditContext) {
  return withArithmeticTranslation(async () =>
    expect(await updateSaleItemRecord(branchId, saleId, saleItemId, values, auditContext), ['updated', 'unchanged']),
  );
}

async function deleteSaleItem(branchId, saleId, saleItemId, auditContext) {
  return withArithmeticTranslation(async () =>
    expect(await deleteSaleItemRecord(branchId, saleId, saleItemId, auditContext), ['deleted']),
  );
}

async function completeSale(branchId, saleId, auditContext) {
  return withArithmeticTranslation(async () =>
    expect(await completeSaleRecord(branchId, saleId, auditContext), ['completed']).sale,
  );
}

async function cancelSale(branchId, saleId, auditContext) {
  return expect(await cancelSaleRecord(branchId, saleId, auditContext), ['cancelled']).sale;
}

export {
  addSaleItem,
  cancelSale,
  completeSale,
  createSale,
  deleteSaleItem,
  getSale,
  listSales,
  updateSale,
  updateSaleItem,
};

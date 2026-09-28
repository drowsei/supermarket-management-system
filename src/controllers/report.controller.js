import {
  branchOverviewReport,
  customerReport,
  inventoryMovementReport,
  inventoryReport,
  organizationBranchesReport,
  paymentsReport,
  productPerformanceReport,
  purchasingReport,
  returnsReport,
  salesSummaryReport,
  salesTrendReport,
  supplierReport,
  tillReport,
} from '../services/report.service.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateReportRequestBody } from '../validators/reports/common.validator.js';
import {
  validateBranchComparisonQuery,
  validateCustomerReportQuery,
  validateInventoryReportQuery,
  validateMovementReportQuery,
  validateOverviewQuery,
  validatePaymentsReportQuery,
  validateProductReportQuery,
  validatePurchasingReportQuery,
  validateReturnsReportQuery,
  validateSalesSummaryQuery,
  validateSalesTrendQuery,
  validateSupplierReportQuery,
  validateTillReportQuery,
} from '../validators/reports/report.validator.js';

function branch(request) {
  return request.reportBranch;
}

function validateGet(request) {
  validateReportRequestBody(request.body);
}

function send(response, data) {
  response.status(200).json({ success: true, data });
}

function sendPage(response, filters, result) {
  const { totalItems, ...data } = result;
  send(response, {
    ...data,
    pagination: paginationMetadata(filters.page, filters.limit, totalItems),
  });
}

async function getOrganizationBranchesReport(request, response) {
  validateGet(request);
  const filters = validateBranchComparisonQuery(request.query);
  sendPage(response, filters, await organizationBranchesReport(filters));
}

async function getBranchOverviewReport(request, response) {
  validateGet(request);
  const filters = validateOverviewQuery(request.query);
  send(response, await branchOverviewReport(branch(request), filters));
}

async function getSalesSummaryReport(request, response) {
  validateGet(request);
  const filters = validateSalesSummaryQuery(request.query);
  send(response, await salesSummaryReport(branch(request), filters));
}

async function getSalesTrendReport(request, response) {
  validateGet(request);
  const filters = validateSalesTrendQuery(request.query);
  send(response, await salesTrendReport(branch(request), filters));
}

async function getProductPerformanceReport(request, response) {
  validateGet(request);
  const filters = validateProductReportQuery(request.query);
  sendPage(response, filters, await productPerformanceReport(branch(request), filters));
}

async function getReturnsReport(request, response) {
  validateGet(request);
  const filters = validateReturnsReportQuery(request.query);
  sendPage(response, filters, await returnsReport(branch(request), filters));
}

async function getPaymentsReport(request, response) {
  validateGet(request);
  const filters = validatePaymentsReportQuery(request.query);
  send(response, await paymentsReport(branch(request), filters));
}

async function getInventoryReport(request, response) {
  validateGet(request);
  const filters = validateInventoryReportQuery(request.query);
  sendPage(response, filters, await inventoryReport(branch(request), filters));
}

async function getInventoryMovementReport(request, response) {
  validateGet(request);
  const filters = validateMovementReportQuery(request.query);
  sendPage(response, filters, await inventoryMovementReport(branch(request), filters));
}

async function getPurchasingReport(request, response) {
  validateGet(request);
  const filters = validatePurchasingReportQuery(request.query);
  send(response, await purchasingReport(branch(request), filters));
}

async function getSupplierReport(request, response) {
  validateGet(request);
  const filters = validateSupplierReportQuery(request.query);
  sendPage(response, filters, await supplierReport(branch(request), filters));
}

async function getTillReport(request, response) {
  validateGet(request);
  const filters = validateTillReportQuery(request.query);
  sendPage(response, filters, await tillReport(branch(request), filters));
}

async function getCustomerReport(request, response) {
  validateGet(request);
  const filters = validateCustomerReportQuery(request.query);
  sendPage(response, filters, await customerReport(branch(request), filters));
}

export {
  getBranchOverviewReport,
  getCustomerReport,
  getInventoryMovementReport,
  getInventoryReport,
  getOrganizationBranchesReport,
  getPaymentsReport,
  getProductPerformanceReport,
  getPurchasingReport,
  getReturnsReport,
  getSalesSummaryReport,
  getSalesTrendReport,
  getSupplierReport,
  getTillReport,
};

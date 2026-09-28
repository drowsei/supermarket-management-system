import { Router } from 'express';

import {
  getBranchOverviewReport,
  getCustomerReport,
  getInventoryMovementReport,
  getInventoryReport,
  getPaymentsReport,
  getProductPerformanceReport,
  getPurchasingReport,
  getReturnsReport,
  getSalesSummaryReport,
  getSalesTrendReport,
  getSupplierReport,
  getTillReport,
} from '../../../controllers/report.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
import { loadReportBranch } from '../../../middleware/reportBranch.middleware.js';

const router = Router({ mergeParams: true });
const branchId = (request) => request.reportBranch.branchId;
const canReadReports = requireBranchPermission('reports.read', branchId);

router.use(loadReportBranch);
router.get('/overview', canReadReports, getBranchOverviewReport);
router.get('/sales/summary', canReadReports, getSalesSummaryReport);
router.get('/sales/trend', canReadReports, getSalesTrendReport);
router.get('/products', canReadReports, getProductPerformanceReport);
router.get('/returns', canReadReports, getReturnsReport);
router.get('/payments', canReadReports, getPaymentsReport);
router.get('/inventory', canReadReports, getInventoryReport);
router.get('/inventory/movements', canReadReports, getInventoryMovementReport);
router.get('/purchasing', canReadReports, getPurchasingReport);
router.get('/suppliers', canReadReports, getSupplierReport);
router.get('/tills', canReadReports, getTillReport);
router.get('/customers', canReadReports, getCustomerReport);

export default router;

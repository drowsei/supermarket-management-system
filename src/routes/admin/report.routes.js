import { Router } from 'express';

import { getOrganizationBranchesReport } from '../../controllers/report.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const router = Router();

router.get('/branches', requirePermission('reports.read'), getOrganizationBranchesReport);

export default router;

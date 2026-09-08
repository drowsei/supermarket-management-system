import { Router } from 'express';

import brandRouter from './brand.routes.js';
import categoryRouter from './category.routes.js';
import taxRateRouter from './taxRate.routes.js';
import unitRouter from './unit.routes.js';

const router = Router();

router.use('/units', unitRouter);
router.use('/categories', categoryRouter);
router.use('/brands', brandRouter);
router.use('/tax-rates', taxRateRouter);

export default router;

import { Router } from 'express';

import { loadPricingBranch } from '../../../middleware/pricingBranch.middleware.js';
import effectivePriceRouter from './effectivePrice.routes.js';
import packagePriceRouter from './packagePrice.routes.js';
import variantPriceRouter from './variantPrice.routes.js';

const router = Router({ mergeParams: true });

router.use(loadPricingBranch);
router.use(effectivePriceRouter);
router.use(variantPriceRouter);
router.use(packagePriceRouter);

export default router;

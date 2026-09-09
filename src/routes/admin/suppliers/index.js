import { Router } from 'express';

import supplierProductPackageRouter from './supplierProductPackage.routes.js';
import supplierProductRouter from './supplierProduct.routes.js';
import supplierRouter from './supplier.routes.js';

const router = Router({ mergeParams: true });

router.use(supplierProductPackageRouter);
router.use(supplierProductRouter);
router.use(supplierRouter);

export default router;

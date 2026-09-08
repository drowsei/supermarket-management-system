import { Router } from 'express';

import productBarcodeRouter from './productBarcode.routes.js';
import productPackageRouter from './productPackage.routes.js';
import productRouter from './product.routes.js';
import productVariantRouter from './productVariant.routes.js';

const router = Router();

router.use(productRouter);
router.use(productVariantRouter);
router.use(productPackageRouter);
router.use(productBarcodeRouter);

export default router;

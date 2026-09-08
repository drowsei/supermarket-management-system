import { Router } from 'express';

import {
  createProductBarcodeRecord,
  deleteProductBarcodeRecord,
  getProductBarcodeRecord,
  listProductBarcodeRecords,
  lookupProductBarcodeRecord,
  updateProductBarcodeRecord,
} from '../../../controllers/productBarcode.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get(
  '/variants/:variantId/barcodes',
  requirePermission('products.read'),
  listProductBarcodeRecords,
);
router.post(
  '/variants/:variantId/barcodes',
  requirePermission('products.manage'),
  createProductBarcodeRecord,
);
router.get(
  '/barcodes/lookup',
  requirePermission('products.read'),
  lookupProductBarcodeRecord,
);
router.get(
  '/barcodes/:barcodeId',
  requirePermission('products.read'),
  getProductBarcodeRecord,
);
router.patch(
  '/barcodes/:barcodeId',
  requirePermission('products.manage'),
  updateProductBarcodeRecord,
);
router.delete(
  '/barcodes/:barcodeId',
  requirePermission('products.manage'),
  deleteProductBarcodeRecord,
);

export default router;

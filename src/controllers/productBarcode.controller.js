import {
  createProductBarcode,
  deleteProductBarcode,
  getProductBarcode,
  listProductBarcodes,
  lookupProductBarcode,
  updateProductBarcode,
} from '../services/productBarcode.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateBarcodeId,
  validateCreateProductBarcode,
  validateProductBarcodeListQuery,
  validateProductBarcodeLookupQuery,
  validateUpdateProductBarcode,
} from '../validators/products/productBarcode.validator.js';
import { validateVariantId } from '../validators/products/productVariant.validator.js';

async function listProductBarcodeRecords(request, response) {
  const variantId = validateVariantId(request.params.variantId);
  const filters = validateProductBarcodeListQuery(request.query);
  const result = await listProductBarcodes(variantId, filters);

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function getProductBarcodeRecord(request, response) {
  const barcodeId = validateBarcodeId(request.params.barcodeId);
  const productBarcode = await getProductBarcode(barcodeId);

  response.status(200).json({
    success: true,
    data: { productBarcode },
  });
}

async function createProductBarcodeRecord(request, response) {
  const variantId = validateVariantId(request.params.variantId);
  const values = validateCreateProductBarcode(request.body);
  const productBarcode = await createProductBarcode(
    variantId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({
    success: true,
    data: { productBarcode },
  });
}

async function updateProductBarcodeRecord(request, response) {
  const barcodeId = validateBarcodeId(request.params.barcodeId);
  const changes = validateUpdateProductBarcode(request.body);
  const productBarcode = await updateProductBarcode(
    barcodeId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { productBarcode },
  });
}

async function lookupProductBarcodeRecord(request, response) {
  const { barcode } = validateProductBarcodeLookupQuery(request.query);
  const productBarcode = await lookupProductBarcode(barcode);

  response.status(200).json({
    success: true,
    data: { productBarcode },
  });
}

async function deleteProductBarcodeRecord(request, response) {
  const barcodeId = validateBarcodeId(request.params.barcodeId);
  const productBarcode = await deleteProductBarcode(
    barcodeId,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    message: 'Product barcode deleted',
    data: { productBarcode },
  });
}

export {
  createProductBarcodeRecord,
  deleteProductBarcodeRecord,
  getProductBarcodeRecord,
  listProductBarcodeRecords,
  lookupProductBarcodeRecord,
  updateProductBarcodeRecord,
};

import {
  createProductBarcodeRecord,
  deleteProductBarcodeRecord,
  findProductBarcodeById,
  findProductBarcodeByValue,
  listProductBarcodes as listProductBarcodeRecords,
  updateProductBarcodeRecord,
} from '../repositories/productBarcode.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwBarcodeOutcomeError(result) {
  const errors = {
    variant_not_found: [404, 'Product variant not found'],
    package_not_found: [404, 'Product package not found'],
    primary_conflict: [
      409,
      'Another primary barcode exists in this scope',
    ],
    historical_barcode: [
      409,
      'Barcode identity cannot change after it has been used by a sale',
    ],
    historical_barcode_delete: [
      409,
      'A barcode used by a sale cannot be deleted',
    ],
  };

  if (result.outcome === 'invalid_barcode') {
    throw new HttpError(400, result.message);
  }

  const error = errors[result.outcome];

  if (!error) {
    throw new Error('The product-barcode repository returned an unknown outcome.');
  }

  throw new HttpError(...error);
}

async function listProductBarcodes(productVariantId, filters) {
  const result = await listProductBarcodeRecords(
    productVariantId,
    filters,
  );

  if (result.outcome === 'variant_not_found') {
    throw new HttpError(404, 'Product variant not found');
  }

  return { items: result.items, totalItems: result.totalItems };
}

async function getProductBarcode(barcodeId) {
  const productBarcode = await findProductBarcodeById(barcodeId);

  if (!productBarcode) {
    throw new HttpError(404, 'Product barcode not found');
  }

  return productBarcode;
}

async function lookupProductBarcode(barcode) {
  const productBarcode = await findProductBarcodeByValue(barcode);

  if (!productBarcode) {
    throw new HttpError(404, 'Product barcode not found');
  }

  return productBarcode;
}

async function createProductBarcode(
  productVariantId,
  values,
  auditContext,
) {
  let result;

  try {
    result = await createProductBarcodeRecord(
      productVariantId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Barcode or primary barcode for this scope already exists',
    );
  }

  if (result.outcome === 'created') {
    return result.productBarcode;
  }

  return throwBarcodeOutcomeError(result);
}

async function updateProductBarcode(
  barcodeId,
  changes,
  auditContext,
) {
  let result;

  try {
    result = await updateProductBarcodeRecord(
      barcodeId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Barcode or primary barcode for this scope already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Product barcode not found');
  }

  if (result.outcome === 'updated' || result.outcome === 'unchanged') {
    return result.productBarcode;
  }

  return throwBarcodeOutcomeError(result);
}

async function deleteProductBarcode(barcodeId, auditContext) {
  const result = await deleteProductBarcodeRecord(barcodeId, auditContext);

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Product barcode not found');
  }

  if (result.outcome === 'deleted') {
    return result.productBarcode;
  }

  return throwBarcodeOutcomeError(result);
}

export {
  createProductBarcode,
  deleteProductBarcode,
  getProductBarcode,
  listProductBarcodes,
  lookupProductBarcode,
  updateProductBarcode,
};

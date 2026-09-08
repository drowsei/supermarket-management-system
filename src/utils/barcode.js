const GTIN_LENGTHS = Object.freeze({
  EAN_8: 8,
  UPC_A: 12,
  EAN_13: 13,
  GTIN_14: 14,
});

function hasValidGtinCheckDigit(value) {
  const payload = value.slice(0, -1);
  let sum = 0;

  for (let index = payload.length - 1, position = 0; index >= 0; index -= 1) {
    sum += Number(payload[index]) * (position % 2 === 0 ? 3 : 1);
    position += 1;
  }

  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  return expectedCheckDigit === Number(value.at(-1));
}

function barcodeValidationMessage(barcode, barcodeType) {
  const requiredLength = GTIN_LENGTHS[barcodeType];

  if (requiredLength !== undefined) {
    if (!/^\d+$/.test(barcode) || barcode.length !== requiredLength) {
      return `${barcodeType} must contain exactly ${requiredLength} digits`;
    }

    if (!hasValidGtinCheckDigit(barcode)) {
      return `${barcodeType} has an invalid check digit`;
    }

    return null;
  }

  if (barcodeType === 'PLU' && !/^\d{4,5}$/.test(barcode)) {
    return 'PLU must contain exactly 4 or 5 digits';
  }

  return null;
}

export { barcodeValidationMessage, hasValidGtinCheckDigit };

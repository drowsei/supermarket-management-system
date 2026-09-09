function parseUnsignedScaledDecimal(value, scale, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a decimal string.`);
  }

  const match = value.match(/^(\d+)(?:\.(\d+))?$/);

  if (!match || match[2]?.length > scale) {
    throw new TypeError(`${label} has an invalid decimal representation.`);
  }

  const wholePart = match[1].replace(/^0+(?=\d)/, '');
  const fractionPart = (match[2] ?? '').padEnd(scale, '0');

  return BigInt(`${wholePart}${fractionPart}`);
}

function formatScaledDecimal(value, scale) {
  const digits = value.toString().padStart(scale + 1, '0');

  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function multiplyMoneyByConversion(sellingPrice, conversionToBaseQuantity) {
  const price = parseUnsignedScaledDecimal(
    sellingPrice,
    4,
    'sellingPrice',
  );
  const conversion = parseUnsignedScaledDecimal(
    conversionToBaseQuantity,
    6,
    'conversionToBaseQuantity',
  );
  const product = price * conversion;
  const roundedHalfUp = (product + 500_000n) / 1_000_000n;

  return formatScaledDecimal(roundedHalfUp, 4);
}

export { multiplyMoneyByConversion };

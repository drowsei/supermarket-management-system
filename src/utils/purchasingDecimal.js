function scaled(value, scale) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

function format(value, scale) {
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function roundHalfUp(value, divisor) {
  return (value + divisor / 2n) / divisor;
}

const MAX_QUANTITY_SCALED = 10n ** 15n - 1n;
const MAX_MONEY_SCALED = 10n ** 19n - 1n;

function assertFits(value, maximum) {
  if (value < 0n || value > maximum) {
    const error = new RangeError('Purchasing arithmetic exceeds the database decimal range');
    error.code = 'PURCHASING_ARITHMETIC_OVERFLOW';
    throw error;
  }
}

function deriveBaseQuantity(packageQuantity, conversionFactor) {
  const product = scaled(packageQuantity, 3) * scaled(conversionFactor, 6);
  const quantity = roundHalfUp(product, 1_000_000n);
  assertFits(quantity, MAX_QUANTITY_SCALED);
  return format(quantity, 3);
}

function isWholeBaseQuantity(quantity) {
  return scaled(quantity, 3) % 1_000n === 0n;
}

function calculatePurchaseLine({
  orderedQuantity,
  unitCost,
  discountAmount,
  taxRatePercent,
}) {
  const grossExact = scaled(orderedQuantity, 3) * scaled(unitCost, 4);
  const grossCents = roundHalfUp(grossExact, 100_000n);
  const discountCents = scaled(discountAmount, 2);

  assertFits(grossCents, MAX_MONEY_SCALED);

  if (discountCents > grossCents) {
    return { outcome: 'discount_exceeds_gross' };
  }

  const taxableCents = grossCents - discountCents;
  const taxRate = scaled(taxRatePercent, 4);
  const taxCents = roundHalfUp(taxableCents * taxRate, 1_000_000n);
  const lineTotalCents = grossCents - discountCents + taxCents;

  assertFits(taxCents, MAX_MONEY_SCALED);
  assertFits(lineTotalCents, MAX_MONEY_SCALED);

  return {
    outcome: 'calculated',
    subtotalAmount: format(grossCents, 2),
    taxAmount: format(taxCents, 2),
    lineTotal: format(lineTotalCents, 2),
  };
}

function calculateReceiptLine({
  quantityAccepted,
  actualUnitCost,
  discountAmount,
  taxAmount,
}) {
  const grossExact = scaled(quantityAccepted, 3) * scaled(actualUnitCost, 4);
  const grossCents = roundHalfUp(grossExact, 100_000n);
  const discountCents = scaled(discountAmount, 2);
  const taxCents = scaled(taxAmount, 2);

  assertFits(grossCents, MAX_MONEY_SCALED);

  if (discountCents > grossCents) {
    return { outcome: 'discount_exceeds_gross' };
  }

  const total = grossCents - discountCents + taxCents;
  assertFits(total, MAX_MONEY_SCALED);

  return {
    outcome: 'calculated',
    grossAmount: format(grossCents, 2),
    lineTotal: format(total, 2),
  };
}

function compareDecimals(left, right, scale) {
  const leftValue = scaled(left, scale);
  const rightValue = scaled(right, scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function sumDecimals(values, scale) {
  return format(
    values.reduce((total, value) => total + scaled(value, scale), 0n),
    scale,
  );
}

function subtractDecimals(left, right, scale) {
  return format(scaled(left, scale) - scaled(right, scale), scale);
}

function calculateHeaderTotals(items, shippingAmount) {
  const subtotal = items.reduce(
    (total, item) => total + scaled(item.subtotalAmount, 2),
    0n,
  );
  const discount = items.reduce(
    (total, item) => total + scaled(item.discountAmount, 2),
    0n,
  );
  const tax = items.reduce(
    (total, item) => total + scaled(item.taxAmount, 2),
    0n,
  );
  const shipping = scaled(shippingAmount, 2);
  const total = subtotal - discount + tax + shipping;

  assertFits(subtotal, MAX_MONEY_SCALED);
  assertFits(discount, MAX_MONEY_SCALED);
  assertFits(tax, MAX_MONEY_SCALED);
  assertFits(total, MAX_MONEY_SCALED);

  return {
    subtotalAmount: format(subtotal, 2),
    discountAmount: format(discount, 2),
    taxAmount: format(tax, 2),
    totalAmount: format(total, 2),
  };
}

export {
  calculateHeaderTotals,
  calculatePurchaseLine,
  calculateReceiptLine,
  compareDecimals,
  deriveBaseQuantity,
  isWholeBaseQuantity,
  subtractDecimals,
  sumDecimals,
};

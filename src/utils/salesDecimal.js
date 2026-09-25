const POWERS_OF_TEN = Array.from({ length: 20 }, (_, index) => 10n ** BigInt(index));
const MAX_QUANTITY_SCALED = 10n ** 15n - 1n;
const MAX_MONEY_SCALED = 10n ** 19n - 1n;
const MAX_PRICE_SCALED = 10n ** 19n - 1n;

function parseScaledDecimal(value, scale, { signed = false } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError('Decimal values must be strings.');
  }

  const pattern = signed
    ? /^(-?)(\d+)(?:\.(\d+))?$/
    : /^()(\d+)(?:\.(\d+))?$/;
  const match = pattern.exec(value);

  if (!match || (match[3] ?? '').length > scale) {
    throw new TypeError('Invalid decimal representation.');
  }

  const magnitude = BigInt(
    `${match[2].replace(/^0+(?=\d)/, '')}${(match[3] ?? '').padEnd(scale, '0')}`,
  );

  return match[1] === '-' ? -magnitude : magnitude;
}

function formatScaledDecimal(value, scale) {
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  const digits = magnitude.toString().padStart(scale + 1, '0');

  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function roundHalfUp(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError('HALF-UP rounding requires a non-negative numerator.');
  }

  return (numerator + denominator / 2n) / denominator;
}

function assertRange(value, maximum, code = 'SALES_ARITHMETIC_OVERFLOW') {
  if (value < 0n || value > maximum) {
    const error = new RangeError('Sales arithmetic exceeds the database decimal range.');
    error.code = code;
    throw error;
  }
}

function deriveBaseQuantity(quantity, conversionFactor) {
  const product =
    parseScaledDecimal(quantity, 3) * parseScaledDecimal(conversionFactor, 6);
  const scaledQuantity = roundHalfUp(product, POWERS_OF_TEN[6]);

  assertRange(scaledQuantity, MAX_QUANTITY_SCALED);

  return scaledQuantity === 0n
    ? { outcome: 'base_quantity_zero' }
    : {
        outcome: 'calculated',
        baseQuantity: formatScaledDecimal(scaledQuantity, 3),
      };
}

function taxExclusiveUnitPrice(inclusivePrice, taxRatePercent) {
  const price = parseScaledDecimal(inclusivePrice, 4);
  const rate = parseScaledDecimal(taxRatePercent, 4);
  const net = roundHalfUp(
    price * 1_000_000n,
    1_000_000n + rate,
  );

  assertRange(net, MAX_PRICE_SCALED);
  return formatScaledDecimal(net, 4);
}

function calculateSaleLine({
  quantity,
  unitPrice,
  discountAmount,
  taxRatePercent,
}) {
  const grossExact =
    parseScaledDecimal(quantity, 3) * parseScaledDecimal(unitPrice, 4);
  const grossCents = roundHalfUp(grossExact, POWERS_OF_TEN[5]);
  const discountCents = parseScaledDecimal(discountAmount, 2);

  assertRange(grossCents, MAX_MONEY_SCALED);

  if (discountCents > grossCents) {
    return { outcome: 'discount_exceeds_gross' };
  }

  const taxableCents = grossCents - discountCents;
  const taxRate = parseScaledDecimal(taxRatePercent, 4);
  const taxCents = roundHalfUp(taxableCents * taxRate, 1_000_000n);
  const lineTotalCents = taxableCents + taxCents;

  assertRange(taxCents, MAX_MONEY_SCALED);
  assertRange(lineTotalCents, MAX_MONEY_SCALED);

  return {
    outcome: 'calculated',
    grossAmount: formatScaledDecimal(grossCents, 2),
    taxAmount: formatScaledDecimal(taxCents, 2),
    lineTotal: formatScaledDecimal(lineTotalCents, 2),
  };
}

function calculateSaleHeader(items) {
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;

  for (const item of items) {
    const calculated = calculateSaleLine(item);
    if (calculated.outcome !== 'calculated') return calculated;

    subtotal += parseScaledDecimal(calculated.grossAmount, 2);
    discount += parseScaledDecimal(item.discountAmount, 2);
    tax += parseScaledDecimal(calculated.taxAmount, 2);
  }

  const total = subtotal - discount + tax;
  assertRange(subtotal, MAX_MONEY_SCALED);
  assertRange(discount, MAX_MONEY_SCALED);
  assertRange(tax, MAX_MONEY_SCALED);
  assertRange(total, MAX_MONEY_SCALED);

  return {
    outcome: 'calculated',
    subtotalAmount: formatScaledDecimal(subtotal, 2),
    discountAmount: formatScaledDecimal(discount, 2),
    taxAmount: formatScaledDecimal(tax, 2),
    totalAmount: formatScaledDecimal(total, 2),
  };
}

function isWholeQuantity(value) {
  return parseScaledDecimal(value, 3) % 1_000n === 0n;
}

function compareQuantity(left, right) {
  const leftValue = parseScaledDecimal(left, 3, { signed: true });
  const rightValue = parseScaledDecimal(right, 3, { signed: true });
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function negateQuantity(value) {
  return formatScaledDecimal(-parseScaledDecimal(value, 3), 3);
}

function reconstructWeightedAverage(history, projectedQuantity) {
  let runningQuantity = 0n;
  let carryingValue = 0n;
  let knownValuation = true;

  for (const movement of history) {
    const quantity = parseScaledDecimal(movement.quantityChange, 3, {
      signed: true,
    });
    const nextQuantity = runningQuantity + quantity;

    if (nextQuantity < 0n) {
      return { outcome: 'valuation_history_conflict' };
    }

    if (quantity > 0n) {
      if (movement.unitCost === null) {
        if (nextQuantity > 0n) knownValuation = false;
      } else if (knownValuation) {
        carryingValue +=
          quantity * parseScaledDecimal(movement.unitCost, 4);
      }
    } else if (quantity < 0n) {
      const outgoing = -quantity;

      if (movement.unitCost !== null) {
        if (knownValuation) {
          carryingValue -=
            outgoing * parseScaledDecimal(movement.unitCost, 4);
        }
      } else if (knownValuation && runningQuantity > 0n) {
        const currentAverage = roundHalfUp(carryingValue, runningQuantity);
        carryingValue -= outgoing * currentAverage;
      } else {
        knownValuation = false;
      }
    }

    runningQuantity = nextQuantity;

    if (runningQuantity === 0n) {
      carryingValue = 0n;
      knownValuation = true;
    } else if (knownValuation && carryingValue < 0n) {
      return { outcome: 'valuation_history_conflict' };
    }
  }

  if (
    runningQuantity !==
    parseScaledDecimal(projectedQuantity, 3)
  ) {
    return { outcome: 'valuation_projection_conflict' };
  }

  if (runningQuantity <= 0n) {
    return { outcome: 'valuation_unavailable' };
  }

  if (!knownValuation) {
    return { outcome: 'valuation_unavailable' };
  }

  const unitCost = roundHalfUp(carryingValue, runningQuantity);
  assertRange(unitCost, MAX_PRICE_SCALED, 'SALES_VALUATION_OVERFLOW');

  return {
    outcome: 'calculated',
    unitCost: formatScaledDecimal(unitCost, 4),
  };
}

export {
  calculateSaleHeader,
  calculateSaleLine,
  compareQuantity,
  deriveBaseQuantity,
  formatScaledDecimal,
  isWholeQuantity,
  negateQuantity,
  parseScaledDecimal,
  reconstructWeightedAverage,
  taxExclusiveUnitPrice,
};

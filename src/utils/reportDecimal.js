import {
  formatScaledDecimal,
  parseScaledDecimal,
} from './salesDecimal.js';

function parseMoney(value) {
  return parseScaledDecimal(value ?? '0.00', 2, { signed: true });
}

function addMoney(...values) {
  return formatScaledDecimal(
    values.reduce((total, value) => total + parseMoney(value), 0n),
    2,
  );
}

function subtractMoney(left, right) {
  return formatScaledDecimal(parseMoney(left) - parseMoney(right), 2);
}

function averageMoney(total, count) {
  if (count === 0) return '0.00';
  const value = parseMoney(total);
  const divisor = BigInt(count);
  const magnitude = value < 0n ? -value : value;
  const rounded = (magnitude + divisor / 2n) / divisor;
  return formatScaledDecimal(value < 0n ? -rounded : rounded, 2);
}

function multiplyQuantityByCost(quantity, unitCost) {
  if (unitCost === null || unitCost === undefined) return null;
  const product =
    parseScaledDecimal(quantity, 3, { signed: true }) *
    parseScaledDecimal(unitCost, 4, { signed: true });
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 50_000n) / 100_000n;
  return formatScaledDecimal(product < 0n ? -rounded : rounded, 2);
}

export {
  addMoney,
  averageMoney,
  multiplyQuantityByCost,
  parseMoney,
  subtractMoney,
};

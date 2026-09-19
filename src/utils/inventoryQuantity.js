const QUANTITY_SCALE = 3;
const QUANTITY_FACTOR = 1_000n;
const MAX_QUANTITY = 10n ** 15n - 1n;

function quantityToScaled(value) {
  if (typeof value !== 'string') throw new TypeError('Quantity must be a string');
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) throw new TypeError('Invalid quantity');
  const magnitude = BigInt(`${match[2]}${(match[3] ?? '').padEnd(3, '0')}`);
  return match[1] === '-' ? -magnitude : magnitude;
}

function formatQuantity(value) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const digits = magnitude.toString().padStart(QUANTITY_SCALE + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -QUANTITY_SCALE)}.${digits.slice(-QUANTITY_SCALE)}`;
}

function addQuantities(left, right) {
  const result = quantityToScaled(left) + quantityToScaled(right);
  if (result < -MAX_QUANTITY || result > MAX_QUANTITY) {
    const error = new RangeError('Inventory quantity exceeds DECIMAL(15,3)');
    error.code = 'INVENTORY_QUANTITY_OVERFLOW';
    throw error;
  }
  return formatQuantity(result);
}

function sumQuantities(values) {
  return formatQuantity(values.reduce((sum, value) => sum + quantityToScaled(value), 0n));
}

function compareQuantities(left, right) {
  const a = quantityToScaled(left);
  const b = quantityToScaled(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isWholeQuantity(value) {
  return quantityToScaled(value) % QUANTITY_FACTOR === 0n;
}

function negateQuantity(value) {
  return formatQuantity(-quantityToScaled(value));
}

export {
  addQuantities,
  compareQuantities,
  formatQuantity,
  isWholeQuantity,
  negateQuantity,
  quantityToScaled,
  sumQuantities,
};

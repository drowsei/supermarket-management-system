function databaseBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function toDateString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  return value.toISOString().slice(0, 10);
}

function toIsoString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  return value.toISOString();
}

export { databaseBoolean, toDateString, toIsoString };

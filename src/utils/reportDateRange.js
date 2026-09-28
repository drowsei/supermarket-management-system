import HttpError from './httpError.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateParts(date) {
  return date.split('-').map(Number);
}

function shiftDate(date, days) {
  const [year, month, day] = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString().slice(0, 10);
}

function localParts(timestamp, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  );
  return parts;
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  } catch {
    throw new HttpError(500, 'Branch timezone configuration is invalid');
  }
}

function localMidnightUtc(date, timezone) {
  assertTimezone(timezone);
  const [year, month, day] = dateParts(date);
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observed = localParts(candidate, timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const adjustment = target - observedAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }

  const resolved = localParts(candidate, timezone);
  if (
    resolved.year !== year || resolved.month !== month || resolved.day !== day ||
    resolved.hour !== 0 || resolved.minute !== 0 || resolved.second !== 0
  ) {
    throw new HttpError(400, 'Business date has no local midnight in this timezone');
  }
  return candidate;
}

function sqlUtc(timestamp) {
  return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', '000');
}

function buildBusinessRange(from, to, timezone) {
  return {
    from,
    to,
    timezone,
    startUtc: sqlUtc(localMidnightUtc(from, timezone)),
    endUtcExclusive: sqlUtc(localMidnightUtc(shiftDate(to, 1), timezone)),
  };
}

function inclusiveDayCount(from, to) {
  const [fromYear, fromMonth, fromDay] = dateParts(from);
  const [toYear, toMonth, toDay] = dateParts(to);
  return Math.floor(
    (Date.UTC(toYear, toMonth - 1, toDay) -
      Date.UTC(fromYear, fromMonth - 1, fromDay)) / DAY_MS,
  ) + 1;
}

function localBusinessDate(timestamp, timezone) {
  const parts = localParts(timestamp, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function periodStart(date, groupBy) {
  if (groupBy === 'day') return date;
  const [year, month, day] = dateParts(date);
  if (groupBy === 'month') {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return shiftDate(date, -(weekday === 0 ? 6 : weekday - 1));
}

function enumeratePeriods(from, to, groupBy) {
  const periods = [];
  let current = periodStart(from, groupBy);
  const last = periodStart(to, groupBy);
  while (current <= last) {
    periods.push(current);
    if (groupBy === 'day') current = shiftDate(current, 1);
    else if (groupBy === 'week') current = shiftDate(current, 7);
    else {
      const [year, month] = dateParts(current);
      current = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    }
  }
  return periods;
}

function currentLocalDate(timezone) {
  return localBusinessDate(Date.now(), timezone);
}

export {
  buildBusinessRange,
  currentLocalDate,
  enumeratePeriods,
  inclusiveDayCount,
  localBusinessDate,
  periodStart,
  shiftDate,
};

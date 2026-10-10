export const DEFAULT_BRANCH_TIMEZONE = 'Africa/Lagos';

const FALLBACK_TIMEZONES = Object.freeze([
  'Africa/Accra',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Chicago',
  'America/Los_Angeles',
  'America/New_York',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'Pacific/Auckland',
]);

export function isValidTimeZone(value, intl = Intl) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function supportedTimeZoneIds(existingTimeZone = null, intl = Intl) {
  let timeZones;
  try {
    timeZones = typeof intl.supportedValuesOf === 'function'
      ? intl.supportedValuesOf('timeZone')
      : FALLBACK_TIMEZONES;
  } catch {
    timeZones = FALLBACK_TIMEZONES;
  }

  const values = new Set(timeZones);
  values.add(DEFAULT_BRANCH_TIMEZONE);
  if (isValidTimeZone(existingTimeZone, intl)) values.add(existingTimeZone);
  return [...values].sort();
}

export function timeZoneOptions({ current } = {}) {
  return supportedTimeZoneIds(current).map((timeZone) => ({
    value: timeZone,
    label: timeZone,
  }));
}

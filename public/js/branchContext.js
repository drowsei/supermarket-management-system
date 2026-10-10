const METADATA_UNAVAILABLE_MESSAGE = 'Branch timezone and currency metadata are unavailable to this account. Dashboard and date-sensitive reports cannot run until the server provides authoritative branch metadata.';

export function createScopedBranchIdentity(branchId) {
  const id = String(branchId);
  return { branchId: id, metadataAvailable: false };
}

export function normalizeBranchMetadata(value) {
  const branchId = String(value?.branchId ?? '');
  const branchName = typeof value?.branchName === 'string' ? value.branchName.trim() : '';
  const currencyCode = typeof value?.currencyCode === 'string' ? value.currencyCode.trim() : '';
  const timezone = typeof value?.timezone === 'string' ? value.timezone.trim() : '';
  if (!branchId || !branchName || !currencyCode || !timezone) return createScopedBranchIdentity(branchId);
  return { ...value, branchId, branchName, currencyCode, timezone, metadataAvailable: true };
}

export function branchMetadataFromReport(data, fallback) {
  return normalizeBranchMetadata({
    ...(fallback ?? {}),
    ...(data?.branch ?? {}),
    currencyCode: data?.currencyCode,
    timezone: data?.timezone,
  });
}

export function hasAuthoritativeBranchMetadata(branch) {
  return branch?.metadataAvailable === true
    && Boolean(branch.branchName && branch.currencyCode && branch.timezone);
}

export function branchDisplayName(branch) {
  if (hasAuthoritativeBranchMetadata(branch)) return branch.branchName;
  return `Branch ${String(branch?.branchId ?? '')} (metadata unavailable)`;
}

export function branchMonthRange(branch, now = new Date()) {
  if (!hasAuthoritativeBranchMetadata(branch)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: branch.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { from: `${values.year}-${values.month}-01`, to: `${values.year}-${values.month}-${values.day}` };
}

export function branchLocalDateTimeToUtc(value, timezone) {
  if (!timezone) throw new Error('Branch timezone metadata is required.');
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Expected date and time must be valid.');
  const desired = match.slice(1).map(Number);
  const desiredEpoch = Date.UTC(
    desired[0], desired[1] - 1, desired[2], desired[3], desired[4],
  );
  let candidate = desiredEpoch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = zonedParts(new Date(candidate), timezone);
    const shownEpoch = Date.UTC(
      shown.year, shown.month - 1, shown.day, shown.hour, shown.minute,
    );
    candidate += desiredEpoch - shownEpoch;
  }
  const verified = zonedParts(new Date(candidate), timezone);
  if ([
    verified.year, verified.month, verified.day, verified.hour, verified.minute,
  ].some((part, index) => part !== desired[index])) {
    throw new Error('That local time does not exist in the selected branch timezone.');
  }
  return new Date(candidate).toISOString();
}

export function utcToBranchLocalDateTime(value, timezone) {
  if (!value || !timezone) return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return '';
  const parts = zonedParts(instant, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function zonedParts(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'gregory',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export { METADATA_UNAVAILABLE_MESSAGE };

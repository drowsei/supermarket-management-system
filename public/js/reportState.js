export const PAGINATED_REPORT_IDS = Object.freeze([
  'organization', 'products', 'returns', 'inventory',
  'movements', 'suppliers', 'tills', 'customers',
]);

export function isPaginatedReport(reportId) {
  return PAGINATED_REPORT_IDS.includes(reportId);
}

export function createReportRequestState(reportId, filters = {}, { page = 1, limit = 20 } = {}) {
  return { reportId, filters: { ...filters }, page, limit };
}

export function changeReportFilters(state, filters) {
  return { ...state, filters: { ...filters }, page: 1 };
}

export function changeReportPage(state, page) {
  return { ...state, page: Math.max(1, Number(page) || 1) };
}

export function buildReportRequestQuery(state) {
  return {
    ...state.filters,
    ...(isPaginatedReport(state.reportId) ? { page: state.page, limit: state.limit } : {}),
  };
}

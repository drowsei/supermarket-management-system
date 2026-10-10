export const ROUTES = new Set(['login','change-password','dashboard','branches','employees','users','roles','catalog','products','pricing','suppliers','purchasing','inventory','inventory-operations','customers','pos','sales','returns','reports','profile']);
const AUTHENTICATION_ROUTES = new Set(['login', 'change-password']);

export function parseHash(hash = '') {
  const raw = (hash || '#/dashboard').replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const route = pathPart.replace(/^\/+|\/+$/g, '') || 'dashboard';
  return {
    route,
    known: ROUTES.has(route),
    query: Object.fromEntries(new URLSearchParams(queryPart)),
  };
}

export function authenticatedInAppHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#/')) return null;
  const parsed = parseHash(hash);
  if (!parsed.known || AUTHENTICATION_ROUTES.has(parsed.route)) return null;
  const query = new URLSearchParams(parsed.query);
  return `#/${parsed.route}${query.size ? `?${query}` : ''}`;
}

export function createInAppRouteHistory(fallback = '#/dashboard') {
  const routes = [];
  return {
    record(hash) {
      const safe = authenticatedInAppHash(hash);
      if (safe && routes.at(-1) !== safe) routes.push(safe);
      return safe;
    },
    back() {
      if (routes.length <= 1) return fallback;
      routes.pop();
      return routes.at(-1) ?? fallback;
    },
    clear() {
      routes.length = 0;
    },
    entries: () => [...routes],
  };
}

export function navigate(route, query = {}) {
  const encoded = new URLSearchParams();
  for (const [key,value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') encoded.set(key,String(value));
  }
  location.hash = `#/${route}${encoded.size ? `?${encoded}` : ''}`;
}

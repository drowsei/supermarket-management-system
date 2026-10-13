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

export function createInAppRouteHistory(fallback = '#/dashboard', browser = null) {
  fallback = authenticatedInAppHash(fallback) ?? '#/dashboard';
  const routes = [];
  let position = -1;
  let session = `${Date.now()}-${Math.random()}`;
  let traversing = false;
  const stamp = () => browser.history.replaceState({
    ...browser.history.state,
    supermarketRoute: { session, position, hash: routes[position] },
  }, '', browser.location.hash);
  return {
    record(hash) {
      const safe = authenticatedInAppHash(hash);
      if (!browser) {
        if (safe && routes.at(-1) !== safe) routes.push(safe);
        return safe;
      }
      traversing = false;
      if (!safe) {
        routes.length = 0;
        position = -1;
        return null;
      }
      const entry = browser.history.state?.supermarketRoute;
      if (entry?.session === session && entry.hash === safe && routes[entry.position] === safe) {
        // Native Back/Forward restores the existing entry instead of recording a new visit.
        position = entry.position;
      } else {
        routes.splice(position + 1);
        routes.push(safe);
        position = routes.length - 1;
        stamp();
      }
      return safe;
    },
    back() {
      if (browser) {
        if (traversing) return routes[position - 1] ?? fallback;
        if (position > 0 && authenticatedInAppHash(browser.location.hash) === routes[position]) {
          traversing = true;
          browser.history.back();
          return routes[position - 1];
        }
        // A direct entry must not send the user to a login page or an external referrer.
        if (browser.location.hash !== fallback) {
          routes.splice(0, routes.length, fallback);
          position = 0;
          browser.history.replaceState({ ...browser.history.state,
            supermarketRoute: { session, position, hash: fallback },
          }, '', fallback);
          browser.dispatchEvent(new Event('hashchange'));
        }
        return fallback;
      }
      if (routes.length <= 1) return fallback;
      routes.pop();
      return routes.at(-1) ?? fallback;
    },
    clear() {
      routes.length = 0;
      position = -1;
      traversing = false;
      session = `${Date.now()}-${Math.random()}`;
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

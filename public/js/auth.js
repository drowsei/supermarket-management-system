import { api } from './api.js';
import { clearRememberedBranch, loadAccessibleBranches } from './branchAccess.js';
import { resetState,setState } from './state.js';
const TOKEN_KEY='supermarket.accessToken';
export function createTokenStore(storage){ return {set(token){storage.setItem(TOKEN_KEY,String(token));},get(){return storage.getItem(TOKEN_KEY);},clear(){storage.removeItem(TOKEN_KEY);}}; }
function browserStore(){ return createTokenStore(sessionStorage); }
export function setToken(token){ browserStore().set(token); }
export function getToken(){ return browserStore().get(); }
export function clearSession(){ browserStore().clear(); clearRememberedBranch(); resetState(); }
export async function authenticate(identifier,password){ const response=await api.post('/api/auth/login',{identifier,password}); setToken(response.data.accessToken); return bootstrapAuthenticatedSession({ freshLogin: true }); }
export async function initializeSession(){ if(!getToken()) return null; const response=await api.get('/api/auth/me'); setState({session:response.data}); return response.data; }
export async function bootstrapAuthenticatedSession({
  initialize = initializeSession,
  loadBranches = loadAccessibleBranches,
  freshLogin = false,
  clearBranch = clearRememberedBranch,
} = {}) {
  if (freshLogin) clearBranch();
  const session=await initialize();
  if(!session)return null;
  // Operational APIs are unavailable until a temporary password is replaced.
  if(session.user?.mustChangePassword)return session;
  await loadBranches(freshLogin ? { session, storedBranchId: null } : { session });
  return session;
}
export function logout(){ clearSession(); location.hash='#/login'; }

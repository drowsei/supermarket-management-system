import { bootstrapAuthenticatedSession, getToken, logout } from './auth.js';
import { rememberBranch } from './branchAccess.js';
import { navigationFor } from './permissions.js';
import { getState, setState } from './state.js';
import { createInAppRouteHistory, parseHash } from './router.js';
import { element, icon } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderChangePassword } from './pages/changePassword.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderProfile } from './pages/profile.js';
import { renderBranches } from './pages/branches.js';
import { renderEmployees } from './pages/employees.js';
import { renderUsers, renderRoles } from './pages/access.js';
import { renderCatalog } from './pages/catalog.js';
import { renderProducts } from './pages/products.js';
import { renderPricing } from './pages/pricing.js';
import { renderSuppliers } from './pages/suppliers.js';
import { renderPurchasing } from './pages/purchasing.js';
import { renderInventory } from './pages/inventory.js';
import { renderInventoryOperations } from './pages/inventoryOperations.js';
import { renderCustomers } from './pages/customers.js';
import { renderPos } from './pages/pos.js';
import { renderSales } from './pages/sales.js';
import { renderReturns } from './pages/returns.js';
import { renderReports } from './pages/reports.js';
import { branchDisplayName } from './branchContext.js';

const root = document.querySelector('#app'); let sessionMessage = ''; let sidebarCollapsed = false;
const routeHistory = createInAppRouteHistory();
const renderers = { dashboard:renderDashboard, branches:renderBranches, employees:renderEmployees, users:renderUsers, roles:renderRoles, catalog:renderCatalog, products:renderProducts, pricing:renderPricing, suppliers:renderSuppliers, purchasing:renderPurchasing, inventory:renderInventory, 'inventory-operations':renderInventoryOperations, customers:renderCustomers, pos:renderPos, sales:renderSales, returns:renderReturns, reports:renderReports, profile:renderProfile };
window.addEventListener('session-expired', () => { sessionMessage='Your session expired. Please sign in again.'; location.hash='#/login'; });
window.addEventListener('hashchange', renderRoute);
window.addEventListener('branch-context-refreshed', renderRoute);

async function boot() {
  if (location.pathname.endsWith('/login.html') && !location.hash) location.hash='#/login';
  if (getToken()) { try { await bootstrapAuthenticatedSession(); } catch { sessionMessage='Your session expired. Please sign in again.'; } }
  await renderRoute();
}
async function renderRoute() {
  const parsed=parseHash(location.hash);setState({route:parsed});const session=getState().session;
  if(!session){routeHistory.clear();renderLogin(root,{message:sessionMessage});return;}
  if(session.user.mustChangePassword&&parsed.route!=='change-password'){location.hash='#/change-password';return;}
  if(parsed.route==='login'){location.hash=session.user.mustChangePassword?'#/change-password':'#/dashboard';return;}
  if(parsed.route==='change-password'){renderChangePassword(root);return;}
  routeHistory.record(location.hash);
  const content=renderShell(parsed.route);const page=content.querySelector('#page-content');
  if(!parsed.known){renderNotFound(page);return;}
  const renderer=renderers[parsed.route];if(!renderer){renderNotFound(page);return;}
  await renderer(page,{query:parsed.query,route:parsed.route});
}
function renderShell(activeRoute) {
  const shell=element('div',{className:`app-shell${sidebarCollapsed?' sidebar-collapsed':''}`});const sidebar=element('aside',{className:'sidebar',attributes:{id:'app-sidebar','aria-label':'Primary navigation'}});
  sidebar.append(element('div',{className:'brand'},[element('span',{className:'brand-mark',text:'SM',attributes:{'aria-hidden':'true'}}),element('span',{text:'Supermarket Management'})]));
  const nav=element('nav',{className:'sidebar-nav'});let section='';
  for(const item of navigationFor(getState().session.authorization,getState().selectedBranchId)){
    if(item.section!==section){section=item.section;nav.append(element('div',{className:'nav-section',text:section}));}
    const navIcon=element('span',{className:'sidebar-nav-icon',attributes:{'aria-hidden':'true'}},[icon(item.icon)]);
    const navLabel=element('span',{className:'sidebar-nav-label',text:item.label});
    const link=element('a',{className:'nav-link',attributes:{href:`#/${item.route}`,'aria-current':item.route===activeRoute?'page':null,'aria-label':item.label,title:item.label}},[navIcon,navLabel]);
    link.addEventListener('click',()=>closeDrawer());
    nav.append(link);
  }
  sidebar.append(nav);
  const column=element('div',{className:'app-column'});const topbar=element('header',{className:'topbar'});const backdrop=element('button',{className:'sidebar-backdrop',attributes:{type:'button','aria-label':'Close navigation'}});
  const backButton=element('button',{className:'topbar-menu-control topbar-back-control',text:'← Back',attributes:{type:'button','aria-label':'Go back'}});
  backButton.addEventListener('click',()=>{location.hash=routeHistory.back();});
  const menuButton=element('button',{className:'topbar-menu-control mobile-menu',attributes:{type:'button','aria-label':'Open navigation','aria-controls':'app-sidebar','aria-expanded':'false'}},[element('span',{className:'menu-glyph',text:'☰',attributes:{'aria-hidden':'true'}}),element('span',{className:'topbar-control-label',text:'Menu'})]);
  const closeDrawer=()=>{sidebar.classList.remove('is-open');backdrop.classList.remove('is-open');menuButton.setAttribute('aria-expanded','false');};
  menuButton.addEventListener('click',()=>{const open=sidebar.classList.toggle('is-open');backdrop.classList.toggle('is-open',open);menuButton.setAttribute('aria-expanded',String(open));});backdrop.addEventListener('click',closeDrawer);
  const desktopLabel=element('span',{className:'topbar-control-label',text:sidebarCollapsed?'Expand menu':'Collapse menu'});
  const desktopCollapse=element('button',{className:'topbar-menu-control desktop-sidebar-toggle',attributes:{type:'button','aria-label':sidebarCollapsed?'Expand navigation':'Collapse navigation','aria-controls':'app-sidebar','aria-expanded':String(!sidebarCollapsed)}},[element('span',{className:'menu-glyph',text:'☰',attributes:{'aria-hidden':'true'}}),desktopLabel]);
  desktopCollapse.addEventListener('click',()=>{sidebarCollapsed=!sidebarCollapsed;shell.classList.toggle('sidebar-collapsed',sidebarCollapsed);desktopCollapse.setAttribute('aria-expanded',String(!sidebarCollapsed));desktopCollapse.setAttribute('aria-label',sidebarCollapsed?'Expand navigation':'Collapse navigation');desktopLabel.textContent=sidebarCollapsed?'Expand menu':'Collapse menu';});
  const title=element('div',{className:'topbar-title'},[element('strong',{text:'Store operations'}),element('small',{text:'Branch management workspace'})]);
  const branchSelect=element('select',{className:'input branch-context',attributes:{'aria-label':'Current branch'}});
  const branches=getState().branches;
  if(branches.length===0){
    branchSelect.append(element('option',{text:'No accessible branches',attributes:{value:''}}));
    branchSelect.disabled=true;
  }else{
    branchSelect.append(element('option',{text:'Select a branch',attributes:{value:''}}));
    for(const branch of branches)branchSelect.append(element('option',{text:branchDisplayName(branch),attributes:{value:String(branch.branchId)}}));
  }
  branchSelect.value=getState().selectedBranchId??'';
  branchSelect.addEventListener('change',()=>{rememberBranch(branchSelect.value||null);renderRoute();});
  topbar.append(backButton,menuButton,desktopCollapse,title,branchSelect,accountMenu());const main=element('main',{className:'main-content',attributes:{id:'main-content'}});main.append(element('div',{attributes:{id:'page-content'}}));column.append(topbar,main);shell.append(sidebar,column,backdrop);root.replaceChildren(shell);return shell;
}
function accountMenu(){const wrap=element('div',{className:'account-menu'});const user=getState().session.user;const button=element('button',{className:'account-button',attributes:{type:'button','aria-haspopup':'menu','aria-expanded':'false'}},[element('span',{className:'avatar',text:(user.username?.[0]??'U').toUpperCase()}),element('span',{text:user.username})]);const menu=element('div',{className:'menu hidden',attributes:{role:'menu'}});menu.append(element('a',{text:'Profile',attributes:{href:'#/profile',role:'menuitem'}}));const signOut=element('button',{text:'Sign out',attributes:{type:'button',role:'menuitem'}});signOut.addEventListener('click',logout);menu.append(signOut);button.addEventListener('click',()=>{const open=menu.classList.toggle('hidden')===false;button.setAttribute('aria-expanded',String(open));});wrap.append(button,menu);return wrap;}
function renderNotFound(container){document.title='Page not found · Supermarket Management System';container.replaceChildren(element('div',{className:'card state-panel'},[element('h1',{text:'Page not found'}),element('p',{className:'muted',text:'This frontend route does not exist.'}),element('a',{className:'button button-primary',text:'Return to dashboard',attributes:{href:'#/dashboard'}})]));}
boot();

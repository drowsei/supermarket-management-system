export function hasPermission(authorization, code, branchId = null) {
  if (!authorization || !code) return false;
  if ((authorization.permissions?.global ?? []).includes(code)) return true;
  if (branchId === null || branchId === undefined) return false;
  return (authorization.permissions?.byBranch?.[String(branchId)] ?? []).includes(code);
}
export function hasGlobalPermission(authorization, code) { return Boolean(authorization?.permissions?.global?.includes(code)); }
export function accessibleBranchIds(authorization, codes = []) { const result = new Set(); for (const [id, permissions] of Object.entries(authorization?.permissions?.byBranch ?? {})) if (codes.some((code) => permissions.includes(code))) result.add(String(id)); return [...result]; }
export const NAVIGATION = [
  { section:'Overview', label:'Dashboard', route:'dashboard', icon:'dashboard', permissions:['reports.read'], branch:true },
  { section:'Administration', label:'Branches', route:'branches', icon:'store', permissions:['branches.read'] },
  { section:'Administration', label:'Employees', route:'employees', icon:'users', permissions:['employees.read'] },
  { section:'Administration', label:'Users', route:'users', icon:'user', permissions:['users.read'] },
  { section:'Administration', label:'Roles & access', route:'roles', icon:'shield', permissions:['roles.read','permissions.read'] },
  { section:'Catalog', label:'Reference catalog', route:'catalog', icon:'list', permissions:['catalog.read'] },
  { section:'Catalog', label:'Products', route:'products', icon:'package', permissions:['products.read'] },
  { section:'Catalog', label:'Branch pricing', route:'pricing', icon:'tag', permissions:['pricing.read'], branch:true },
  { section:'Operations', label:'Suppliers', route:'suppliers', icon:'truck', permissions:['suppliers.read'] },
  { section:'Operations', label:'Purchasing', route:'purchasing', icon:'cart', permissions:['purchasing.read','receiving.read'], branch:true },
  { section:'Operations', label:'Inventory', route:'inventory', icon:'warehouse', permissions:['inventory.read'], branch:true },
  { section:'Operations', label:'Inventory operations', route:'inventory-operations', icon:'activity', permissions:['inventory_adjustments.read','stock_counts.read','stock_transfers.read'], branch:true },
  { section:'Operations', label:'Customers', route:'customers', icon:'users', permissions:['customers.read'] },
  { section:'Sales', label:'POS & tills', route:'pos', icon:'terminal', permissions:['pos_registers.read','till_sessions.read','payment_methods.read'], branch:true },
  { section:'Sales', label:'Sales & payments', route:'sales', icon:'receipt', permissions:['sales.read','payments.read'], branch:true },
  { section:'Sales', label:'Returns & refunds', route:'returns', icon:'return', permissions:['returns.read'], branch:true },
  { section:'Insights', label:'Reports', route:'reports', icon:'chart', permissions:['reports.read'], branch:true },
  { section:'Account', label:'Profile', route:'profile', icon:'user', authenticated:true },
];
export function navigationFor(authorization, branchId = null) { return NAVIGATION.filter((item) => item.authenticated || item.permissions.some((code) => hasPermission(authorization, code, item.branch ? branchId : null))); }

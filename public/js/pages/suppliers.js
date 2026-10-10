import { api } from '../api.js';
import { remoteSelect } from '../components/entitySelector.js';
import { renderResourcePage } from '../components/resourcePage.js';
import { supplierConfig, supplierPackageConfig, supplierProductConfig } from '../contracts.js';
import { renderWorkspace, selectionGate } from './workspace.js';

export function supplierWorkspaceSelector() {
  return remoteSelect('supplierId', 'Supplier', {
    path: '/api/admin/suppliers',
    valueKey: 'supplierId',
    label: (item) => `${item.supplierName} · ${item.supplierCode}`,
    query: { status: 'ACTIVE' },
    emptyMessage: 'No active suppliers are available. Add or activate a supplier first.',
  }, true);
}

export function supplierProductWorkspaceSelector(supplierId) {
  return remoteSelect('supplierProductId', 'Supplier product', {
    path: `/api/admin/suppliers/${encodeURIComponent(String(supplierId))}/products`,
    valueKey: 'supplierProductId',
    label: (item) => `${item.variantName} · ${item.sku}${item.supplierSku ? ` · Supplier SKU ${item.supplierSku}` : ''}`,
    emptyMessage: 'This supplier has no catalog products. Add a supplier product before configuring packages.',
  }, true);
}

export async function renderSuppliers(root, context) {
  const tab = context.query.tab ?? 'suppliers';
  if (['catalog', 'packages'].includes(tab) && !context.query.supplierId) {
    selectionGate(root, {
      title: tab === 'packages' ? 'Supplier packages' : 'Supplier catalog',
      message: tab === 'packages'
        ? 'Choose a supplier before managing its ordering packages.'
        : 'Choose a supplier to review or maintain its product catalog.',
      selector: supplierWorkspaceSelector(),
      route: 'suppliers',
      query: { tab },
      submitLabel: 'Open supplier',
    });
    return;
  }
  if (tab === 'packages' && !context.query.supplierProductId) {
    selectionGate(root, {
      title: 'Supplier packages',
      message: 'Choose a product from this supplier’s catalog to manage its package mappings.',
      selector: supplierProductWorkspaceSelector(context.query.supplierId),
      route: 'suppliers',
      query: { tab: 'packages', supplierId: String(context.query.supplierId) },
      submitLabel: 'Open packages',
    });
    return;
  }

  const banner = await supplierContextBanner(context.query.supplierId, context.query.supplierProductId);
  return renderWorkspace(root, {
    active: tab,
    banner,
    context: { ...context, route: 'suppliers' },
    tabs: [
      { id: 'suppliers', label: 'Suppliers', render: (pane) => renderResourcePage(pane, supplierConfig, context) },
      { id: 'catalog', label: 'Supplier catalog', render: (pane) => renderResourcePage(pane, supplierProductConfig, { supplierId: context.query.supplierId }) },
      { id: 'packages', label: 'Supplier packages', render: (pane) => renderResourcePage(pane, supplierPackageConfig, { supplierId: context.query.supplierId, supplierProductId: context.query.supplierProductId }) },
    ],
  });
}

async function supplierContextBanner(supplierId, supplierProductId) {
  if (!supplierId) return null;
  try {
    const supplierResponse = await api.get(`/api/admin/suppliers/${encodeURIComponent(String(supplierId))}`);
    const supplier = supplierResponse.data?.supplier;
    let text = `Supplier: ${supplier.supplierName} · ${supplier.supplierCode}`;
    if (supplierProductId) {
      const productResponse = await api.get(`/api/admin/suppliers/${encodeURIComponent(String(supplierId))}/products/${encodeURIComponent(String(supplierProductId))}`);
      const product = productResponse.data?.supplierProduct;
      if (product) text += ` · Product: ${product.variantName} (${product.sku})`;
    }
    return text;
  } catch {
    return 'Supplier workspace';
  }
}

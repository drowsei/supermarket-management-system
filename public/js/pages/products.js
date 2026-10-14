import { remoteSelect } from '../components/entitySelector.js';
import { renderResourcePage } from '../components/resourcePage.js';
import { barcodeConfig, packageConfig, productConfig, variantConfig } from '../contracts.js';
import { renderWorkspace, selectionGate } from './workspace.js';

export function productWorkspaceSelector() {
  return remoteSelect('productId', 'Product', {
    path: '/api/admin/catalog/products',
    valueKey: 'productId',
    label: (item) => `${item.productName} · ${item.productCode}`,
    searchPlaceholder: 'Search products by name or code',
    emptyMessage: 'No products are available. Create a product before configuring variants.',
  }, true);
}

export function variantWorkspaceSelector(productId) {
  return remoteSelect('variantId', 'Product variant', {
    path: `/api/admin/catalog/products/${encodeURIComponent(String(productId))}/variants`,
    valueKey: 'productVariantId',
    label: (item) => `${item.variantName} · ${item.sku}`,
    searchPlaceholder: 'Search variants by name or SKU',
    emptyMessage: 'This product has no variants. Create a variant before configuring packages or barcodes.',
  }, true);
}

export function renderProducts(root, context) {
  const tab = context.query.tab ?? 'products';
  const { productId, variantId } = context.query;
  const tabs = [
    { id: 'products', label: 'Products', render: (pane) => renderResourcePage(pane, productConfig, context) },
    {
      id: 'variants',
      label: 'Variants',
      render: (pane) => productId
        ? renderResourcePage(pane, variantConfig, { productId })
        : selectionGate(pane, {
          title: 'Product variants',
          message: 'Choose a product to review or maintain its sellable variants.',
          selector: productWorkspaceSelector(),
          route: 'products',
          query: { tab: 'variants' },
          submitLabel: 'Open variants',
        }),
    },
    {
      id: 'packages',
      label: 'Packages',
      render: (pane) => renderVariantConfiguration(pane, {
        tab: 'packages', productId, variantId, config: packageConfig,
      }),
    },
    {
      id: 'barcodes',
      label: 'Barcodes',
      render: (pane) => renderVariantConfiguration(pane, {
        tab: 'barcodes', productId, variantId, config: barcodeConfig,
      }),
    },
  ];
  return renderWorkspace(root, { tabs, active: tab, context: { ...context, route: 'products' } });
}

function renderVariantConfiguration(pane, { tab, productId, variantId, config }) {
  if (!productId) {
    return selectionGate(pane, {
      title: 'Variant configuration',
      message: 'Choose a product before selecting the variant to configure.',
      selector: productWorkspaceSelector(),
      route: 'products',
      query: { tab },
      submitLabel: 'Choose product',
    });
  }
  if (!variantId) {
    return selectionGate(pane, {
      title: tab === 'packages' ? 'Variant packages' : 'Variant barcodes',
      message: `Choose a product variant to manage its ${tab}.`,
      selector: variantWorkspaceSelector(productId),
      route: 'products',
      query: { tab, productId: String(productId) },
      submitLabel: tab === 'packages' ? 'Open packages' : 'Open barcodes',
    });
  }
  return renderResourcePage(pane, config, { variantId });
}

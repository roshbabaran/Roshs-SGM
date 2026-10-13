import { ProductsScreen, RequirePermission } from '@sgm/ui';

export default function ProductsPage() {
  return (
    <RequirePermission permission="products.manage">
      <ProductsScreen />
    </RequirePermission>
  );
}

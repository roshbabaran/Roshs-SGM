import { FitTablesToScreen, ProductsScreen, RequirePermission } from '@sgm/ui';

export default function ProductsPage() {
  return (
    <FitTablesToScreen>
      <RequirePermission permission="products.manage">
        <ProductsScreen />
      </RequirePermission>
    </FitTablesToScreen>
  );
}

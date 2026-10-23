import { ProductsScreen, RequirePermission } from '@sgm/ui';

// A page that fails shows what went wrong, with Try again and Sign out, instead of closing the app.
export { ScreenError as ErrorBoundary } from '@sgm/ui';

export default function ProductsPage() {
  return (
    <RequirePermission permission="products.manage">
      <ProductsScreen />
    </RequirePermission>
  );
}

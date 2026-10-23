import { InventoryScreen, RequirePermission } from '@sgm/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';

// A page that fails shows what went wrong, with Try again and Sign out, instead of closing the app.
export { ScreenError as ErrorBoundary } from '@sgm/ui';

/** ?adjust=<productId> opens a stock adjustment of that product (from the dashboard's low-stock list). */
export default function InventoryPage() {
  const { adjust } = useLocalSearchParams<{ adjust?: string }>();
  const router = useRouter();
  return (
    <RequirePermission permission="inventory.view">
      <InventoryScreen adjustProductId={adjust} onAdjustDone={() => router.setParams({ adjust: undefined })} />
    </RequirePermission>
  );
}

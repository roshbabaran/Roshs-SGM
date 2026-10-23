import { InventoryScreen, RequirePermission } from '@sgm/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';

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

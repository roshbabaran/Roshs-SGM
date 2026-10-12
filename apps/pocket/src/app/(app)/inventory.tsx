import { InventoryScreen, RequirePermission } from '@sgm/ui';

import { Screen } from '@/components/Screen';

export default function StockPage() {
  return (
    <Screen>
      <RequirePermission permission="inventory.view">
        <InventoryScreen />
      </RequirePermission>
    </Screen>
  );
}

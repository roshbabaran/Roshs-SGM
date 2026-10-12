import { InventoryScreen, RequirePermission } from '@sgm/ui';

export default function InventoryPage() {
  return (
    <RequirePermission permission="inventory.view">
      <InventoryScreen />
    </RequirePermission>
  );
}

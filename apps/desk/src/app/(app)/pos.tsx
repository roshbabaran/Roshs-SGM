import { PosScreen, RequirePermission } from '@sgm/ui';

export default function PosPage() {
  return (
    <RequirePermission permission="pos.sell">
      <PosScreen />
    </RequirePermission>
  );
}

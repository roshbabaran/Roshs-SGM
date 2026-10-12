import { SalesScreen, RequirePermission } from '@sgm/ui';

export default function SalesPage() {
  return (
    <RequirePermission permission="sales.view">
      <SalesScreen />
    </RequirePermission>
  );
}

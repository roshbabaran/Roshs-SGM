import { RequirePermission, SalesScreen } from '@sgm/ui';

import { Screen } from '@/components/Screen';

export default function SalesPage() {
  return (
    <Screen>
      <RequirePermission permission="sales.view">
        <SalesScreen />
      </RequirePermission>
    </Screen>
  );
}

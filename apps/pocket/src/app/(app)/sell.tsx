import { PosScreen, RequirePermission } from '@sgm/ui';

import { Screen } from '@/components/Screen';

export default function SellPage() {
  return (
    <Screen>
      <RequirePermission permission="pos.sell">
        <PosScreen />
      </RequirePermission>
    </Screen>
  );
}

import { ClaimsScreen, RequirePermission } from '@sgm/ui';

import { Screen } from '@/components/Screen';

export default function ClaimsPage() {
  return (
    <Screen>
      <RequirePermission permission="pos.sell">
        <ClaimsScreen />
      </RequirePermission>
    </Screen>
  );
}

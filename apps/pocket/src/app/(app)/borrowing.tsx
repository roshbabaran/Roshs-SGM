import { BorrowingScreen, RequirePermission } from '@sgm/ui';

import { Screen } from '@/components/Screen';

export default function BorrowingPage() {
  return (
    <Screen>
      <RequirePermission permission="borrow.manage">
        <BorrowingScreen />
      </RequirePermission>
    </Screen>
  );
}

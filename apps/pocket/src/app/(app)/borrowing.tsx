import { BorrowingScreen, RequirePermission } from '@sgm/ui';
import { useLocalSearchParams } from 'expo-router';

import { Screen } from '@/components/Screen';

/** ?show=cheques opens the post-dated cheques (from the dashboard). */
export default function BorrowingPage() {
  const { show } = useLocalSearchParams<{ show?: string }>();
  return (
    <Screen>
      <RequirePermission permission="borrow.manage">
        <BorrowingScreen initialShow={show === 'cheques' ? 'cheques' : 'open'} />
      </RequirePermission>
    </Screen>
  );
}

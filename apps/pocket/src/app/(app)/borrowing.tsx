import { BorrowingScreen, RequirePermission } from '@sgm/ui';
import { useLocalSearchParams } from 'expo-router';

import { Screen } from '@/components/Screen';

// A page that fails shows what went wrong, with Try again and Sign out, instead of closing the app.
export { ScreenError as ErrorBoundary } from '@sgm/ui';

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

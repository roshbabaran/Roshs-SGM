import { BorrowingScreen, RequirePermission } from '@sgm/ui';
import { useLocalSearchParams } from 'expo-router';

/** ?show=cheques opens the post-dated cheques (from the dashboard). */
export default function BorrowingPage() {
  const { show } = useLocalSearchParams<{ show?: string }>();
  return (
    <RequirePermission permission="borrow.manage">
      <BorrowingScreen initialShow={show === 'cheques' ? 'cheques' : 'open'} />
    </RequirePermission>
  );
}

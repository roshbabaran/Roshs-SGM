import { BorrowingScreen, RequirePermission } from '@sgm/ui';

export default function BorrowingPage() {
  return (
    <RequirePermission permission="borrow.manage">
      <BorrowingScreen />
    </RequirePermission>
  );
}

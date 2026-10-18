import { FitTablesToScreen, RequirePermission, SalesScreen } from '@sgm/ui';

export default function TransactionsPage() {
  return (
    <FitTablesToScreen>
      <RequirePermission permission="sales.view">
        <SalesScreen />
      </RequirePermission>
    </FitTablesToScreen>
  );
}

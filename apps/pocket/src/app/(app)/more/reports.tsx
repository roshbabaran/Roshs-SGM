import { FitTablesToScreen, ReportsScreen, RequirePermission } from '@sgm/ui';

export default function ReportsPage() {
  return (
    <FitTablesToScreen>
      <RequirePermission permission="reports.view">
        <ReportsScreen />
      </RequirePermission>
    </FitTablesToScreen>
  );
}

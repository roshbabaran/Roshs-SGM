import { ReportsScreen, RequirePermission } from '@sgm/ui';

export default function ReportsPage() {
  return (
    <RequirePermission permission="reports.view">
      <ReportsScreen />
    </RequirePermission>
  );
}

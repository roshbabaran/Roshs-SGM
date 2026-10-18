import { FitTablesToScreen, RequirePermission, UsersScreen } from '@sgm/ui';

export default function UsersPage() {
  return (
    <FitTablesToScreen>
      <RequirePermission permission="users.manage">
        <UsersScreen />
      </RequirePermission>
    </FitTablesToScreen>
  );
}

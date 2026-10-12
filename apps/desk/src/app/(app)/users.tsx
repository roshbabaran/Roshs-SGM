import { UsersScreen, RequirePermission } from '@sgm/ui';

export default function UsersPage() {
  return (
    <RequirePermission permission="users.manage">
      <UsersScreen />
    </RequirePermission>
  );
}

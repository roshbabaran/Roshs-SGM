import { ClaimsScreen, RequirePermission } from '@sgm/ui';

export default function ClaimsPage() {
  return (
    <RequirePermission permission="pos.sell">
      <ClaimsScreen />
    </RequirePermission>
  );
}

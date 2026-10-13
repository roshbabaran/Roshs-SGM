import { DashboardScreen, useWork } from '@sgm/ui';
import { Redirect } from 'expo-router';

import { Screen } from '@/components/Screen';

/** The dashboard, or the first tab this person may use (warehouse staff start on Stock). */
export default function HomePage() {
  const work = useWork();
  if (!work.can('dashboard.view')) {
    return <Redirect href={work.can('pos.sell') ? '/sell' : work.can('inventory.view') ? '/inventory' : '/more'} />;
  }
  return (
    <Screen>
      <DashboardScreen />
    </Screen>
  );
}

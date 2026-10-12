import { DashboardScreen, useWork } from '@sgm/ui';
import { Redirect } from 'expo-router';

import { PAGES } from '@/navigation';

/** The dashboard, or the first page this person may use (warehouse staff start on Inventory). */
export default function Home() {
  const work = useWork();
  if (!work.can('dashboard.view')) {
    const first = PAGES.find((page) => page.permission && work.can(page.permission));
    return <Redirect href={first?.href ?? '/settings'} />;
  }
  return <DashboardScreen />;
}

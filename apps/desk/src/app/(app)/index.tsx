import { DashboardScreen, useWork } from '@sgm/ui';
import { Redirect, useRouter } from 'expo-router';

import { PAGES } from '@/navigation';

/** The dashboard, or the first page this person may use (warehouse staff start on Inventory). */
export default function Home() {
  const work = useWork();
  const router = useRouter();
  if (!work.can('dashboard.view')) {
    const first = PAGES.find((page) => page.permission && work.can(page.permission));
    return <Redirect href={first?.href ?? '/settings'} />;
  }
  return (
    <DashboardScreen
      onAdjustStock={(productId) => router.navigate({ pathname: '/inventory', params: { adjust: productId } })}
      onOpen={(link) =>
        router.navigate(link === 'claims' ? '/claims' : link === 'inventory' ? '/inventory' : { pathname: '/borrowing', params: { show: 'cheques' } })
      }
    />
  );
}

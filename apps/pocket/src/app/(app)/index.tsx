import { DashboardScreen, useWork } from '@sgm/ui';
import { Redirect, useRouter } from 'expo-router';

import { Screen } from '@/components/Screen';

/** The dashboard, or the first page this person may use (warehouse staff start on Stock, under More). */
export default function HomePage() {
  const work = useWork();
  const router = useRouter();
  if (!work.can('dashboard.view')) {
    return <Redirect href={work.can('pos.sell') ? '/sell' : work.can('inventory.view') ? '/more/inventory' : '/more'} />;
  }
  return (
    <Screen>
      <DashboardScreen
        onAdjustStock={(productId) => router.navigate({ pathname: '/more/inventory', params: { adjust: productId } })}
        onOpen={(link) =>
          router.navigate(link === 'claims' ? '/claims' : link === 'inventory' ? '/more/inventory' : { pathname: '/borrowing', params: { show: 'cheques' } })
        }
      />
    </Screen>
  );
}

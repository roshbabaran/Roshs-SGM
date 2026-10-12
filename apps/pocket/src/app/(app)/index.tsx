import { PosScreen, useWork } from '@sgm/ui';
import { Redirect } from 'expo-router';

import { Screen } from '@/components/Screen';

/** The counter, or the stock page for people who don't sell (warehouse staff). */
export default function SellPage() {
  const work = useWork();
  if (!work.can('pos.sell')) return <Redirect href="/inventory" />;
  return (
    <Screen>
      <PosScreen />
    </Screen>
  );
}

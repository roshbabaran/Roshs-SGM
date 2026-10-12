import { Icon, useSession, useWork, type IconName } from '@sgm/ui';
import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import type { ColorValue } from 'react-native';

const tabIcon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Icon name={name} color={color} size={size} />;

/** Tabs after sign-in. Tabs a person may not use are hidden (href: null). */
export default function AppLayout() {
  const session = useSession();
  const work = useWork();
  if (!session) return <Redirect href="/login" />;

  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: 'Sell', href: work.can('pos.sell') ? undefined : null, tabBarIcon: tabIcon('cart-outline') }} />
      <Tabs.Screen name="inventory" options={{ title: 'Stock', href: work.can('inventory.view') ? undefined : null, tabBarIcon: tabIcon('cube-outline') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: tabIcon('settings-outline') }} />
    </Tabs>
  );
}

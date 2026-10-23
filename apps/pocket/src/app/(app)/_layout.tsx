import { Icon, lightColors, useSession, useWork, type IconName } from '@sgm/ui';
import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import type { ColorValue } from 'react-native';

// A page that fails shows what went wrong, with Try again and Sign out, instead of closing the app.
export { ScreenError as ErrorBoundary } from '@sgm/ui';

const tabIcon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Icon name={name} color={color} size={size} />;

/**
 * Tabs after sign-in: Dashboard, Sell, Claims, Borrowing and More, named as in SGM Desk's menu. Tabs a
 * person may not use are hidden (href: null); More lists the rest, Inventory among them.
 * The tab bar has SGM Desk's sidebar colours from light mode, in light and dark mode alike.
 */
export default function AppLayout() {
  const session = useSession();
  const work = useWork();
  if (!session) return <Redirect href="/login" />;

  const shownIf = (allowed: boolean) => (allowed ? undefined : null);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: lightColors.sidebar, borderTopColor: lightColors.sidebar },
        tabBarActiveTintColor: lightColors.sidebarActiveText,
        tabBarInactiveTintColor: lightColors.sidebarText,
        tabBarActiveBackgroundColor: lightColors.sidebarActive,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Dashboard', href: shownIf(work.can('dashboard.view')), tabBarIcon: tabIcon('grid-outline') }} />
      <Tabs.Screen name="sell" options={{ title: 'Sell', href: shownIf(work.can('pos.sell')), tabBarIcon: tabIcon('cart-outline') }} />
      <Tabs.Screen name="claims" options={{ title: 'Claims', href: shownIf(work.can('pos.sell')), tabBarIcon: tabIcon('bag-check-outline') }} />
      <Tabs.Screen
        name="borrowing"
        options={{ title: 'Borrowing', href: shownIf(work.can('borrow.manage')), tabBarIcon: tabIcon('swap-horizontal-outline') }}
      />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: tabIcon('menu-outline') }} />
    </Tabs>
  );
}

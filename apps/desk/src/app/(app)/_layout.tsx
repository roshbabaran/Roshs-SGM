import { ROLE_LABELS } from '@sgm/core';
import {
  Button,
  Icon,
  SidebarLayout,
  SyncStatusBadge,
  Text,
  useKeyboardShortcuts,
  useServices,
  useSession,
  useSyncStatus,
  useTheme,
  useWork,
  type NavItem,
} from '@sgm/ui';
import { Redirect, Slot, usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { PAGES } from '@/navigation';

/** Every page after sign-in: the sidebar menu (only the pages this person may use) around the page. */
export default function AppLayout() {
  const session = useSession();
  if (!session) return <Redirect href="/login" />;
  return <Shell />;
}

function Shell() {
  const { session, sync } = useServices();
  const { colors } = useTheme();
  const work = useWork();
  const status = useSyncStatus();
  const router = useRouter();
  const pathname = usePathname();

  const pages = PAGES.filter((page) => !page.permission || work.can(page.permission));
  const items: NavItem[] = pages.map((page, index) => ({
    key: page.href,
    label: page.label,
    icon: page.icon,
    active: page.href === '/' ? pathname === '/' : pathname.startsWith(page.href),
    onPress: () => router.navigate(page.href),
    shortcut: index < 9 ? `Ctrl+${index + 1}` : undefined,
  }));
  useKeyboardShortcuts(Object.fromEntries(items.flatMap((item) => (item.shortcut ? [[item.shortcut, item.onPress]] : []))));

  const signOut = () => void session.logout();

  return (
    <SidebarLayout
      appName="SGM Desk"
      subtitle={work.location?.name}
      items={items}
      footer={(compact) =>
        compact ? (
          <>
            <SyncStatusBadge status={status} onPress={() => void sync.syncNow()} compact />
            <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={signOut} style={styles.iconButton}>
              <Icon name="log-out-outline" size={20} color={colors.sidebarText} />
            </Pressable>
          </>
        ) : (
          <>
            <SyncStatusBadge status={status} onPress={() => void sync.syncNow()} />
            {work.user ? (
              <View>
                <Text color={colors.sidebarActiveText} weight="600" numberOfLines={1}>
                  {work.user.displayName}
                </Text>
                <Text variant="small" color={colors.sidebarText}>
                  {ROLE_LABELS[work.user.role]}
                </Text>
              </View>
            ) : null}
            <Button title="Sign out" icon="log-out-outline" variant="secondary" size="sm" onPress={signOut} />
          </>
        )
      }
    >
      <Slot />
    </SidebarLayout>
  );
}

const styles = StyleSheet.create({
  iconButton: { padding: 8, cursor: 'pointer' },
});

import { ROLE_LABELS, type Permission } from '@sgm/core';
import { Card, Icon, ScreenHeader, spacing, Text, useServices, useTheme, useWork, type IconName } from '@sgm/ui';
import { useRouter, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Screen } from '@/components/Screen';

interface MorePage {
  href: Href;
  label: string;
  icon: IconName;
  permission?: Permission;
}

/** Pages that don't fit in the tab bar, in order. Only the ones this person may use are listed. */
const MORE_PAGES: MorePage[] = [
  { href: '/more/sales', label: 'Transactions', icon: 'receipt-outline', permission: 'sales.view' },
  { href: '/more/reports', label: 'Reports', icon: 'bar-chart-outline', permission: 'reports.view' },
  { href: '/more/products', label: 'Products', icon: 'pricetags-outline', permission: 'products.manage' },
  { href: '/more/users', label: 'Users', icon: 'people-outline', permission: 'users.manage' },
  { href: '/more/settings', label: 'Settings', icon: 'settings-outline' },
];

export default function MorePage() {
  const { session } = useServices();
  const work = useWork();
  const router = useRouter();
  const { colors } = useTheme();
  const pages = MORE_PAGES.filter((page) => !page.permission || work.can(page.permission));

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.root}>
        <ScreenHeader
          title={work.user?.displayName ?? 'More'}
          subtitle={[work.user ? ROLE_LABELS[work.user.role] : null, work.location?.name].filter(Boolean).join(' · ')}
        />
        <Card padded={false}>
          {pages.map((page, index) => (
            <MoreRow
              key={page.label}
              icon={page.icon}
              label={page.label}
              onPress={() => router.push(page.href)}
              divider={index > 0}
            />
          ))}
        </Card>
        <Card padded={false}>
          <MoreRow icon="log-out-outline" label="Sign out" color={colors.danger} onPress={() => void session.logout()} />
        </Card>
      </ScrollView>
    </Screen>
  );
}

function MoreRow({
  icon,
  label,
  onPress,
  color,
  divider,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  divider?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        pressed && { backgroundColor: colors.surfaceMuted },
      ]}
    >
      <Icon name={icon} size={22} color={color ?? colors.textMuted} />
      <Text style={styles.label} color={color}>
        {label}
      </Text>
      {color ? null : <Icon name="chevron-forward" size={18} color={colors.textMuted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, minHeight: 54 },
  label: { flex: 1 },
});

import { useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { radius, spacing, useTheme } from './theme';
import { useBreakpoint } from './useBreakpoint';

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  active: boolean;
  onPress: () => void;
  /** Shown next to the label on desktop, e.g. "Ctrl+2". */
  shortcut?: string;
}

/**
 * The SGM Desk frame: a dark sidebar with the menu on the left and the page on
 * the right. On narrower windows the sidebar shrinks to icons only.
 */
export function SidebarLayout({
  appName,
  subtitle,
  items,
  footer,
  children,
}: {
  appName: string;
  subtitle?: string;
  items: NavItem[];
  /** Shown under the menu; gets `compact` when the sidebar is icons only. */
  footer?: (compact: boolean) => ReactNode;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const { width } = useBreakpoint();
  const compact = width < 1100;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.sidebar, { width: compact ? 76 : 236, backgroundColor: colors.sidebar }]}>
        <View style={[styles.brand, compact && styles.brandCompact]}>
          <View style={[styles.logo, { backgroundColor: colors.accent }]}>
            <Icon name="flame" size={18} color="#FFFFFF" />
          </View>
          {compact ? null : (
            <View>
              <Text weight="700" color="#FFFFFF">
                {appName}
              </Text>
              {subtitle ? (
                <Text variant="small" color={colors.sidebarText} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          )}
        </View>

        <ScrollView style={styles.nav} contentContainerStyle={styles.navContent}>
          {items.map((item) => (
            <SidebarButton key={item.key} item={item} compact={compact} />
          ))}
        </ScrollView>

        {footer ? <View style={[styles.footer, compact && styles.footerCompact]}>{footer(compact)}</View> : null}
      </View>
      <View style={styles.main}>{children}</View>
    </View>
  );
}

function SidebarButton({ item, compact }: { item: NavItem; compact: boolean }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  const fg = item.active ? colors.sidebarActiveText : colors.sidebarText;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: item.active }}
      onPress={item.onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.item,
        compact && styles.itemCompact,
        { backgroundColor: item.active ? colors.sidebarActive : hovered ? 'rgba(255,255,255,0.06)' : 'transparent' },
      ]}
    >
      <Icon name={item.icon} size={20} color={fg} />
      {compact ? null : (
        <>
          <Text color={fg} weight={item.active ? '700' : '500'} style={styles.itemLabel}>
            {item.label}
          </Text>
          {item.shortcut && Platform.OS === 'web' ? (
            <Text variant="small" color={colors.sidebarText} style={styles.shortcut}>
              {item.shortcut}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  sidebar: { paddingVertical: spacing.lg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xl },
  brandCompact: { justifyContent: 'center', paddingHorizontal: 0 },
  logo: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  nav: { flex: 1 },
  navContent: { gap: 2, paddingHorizontal: spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    cursor: 'pointer',
  },
  itemCompact: { justifyContent: 'center', paddingHorizontal: 0 },
  itemLabel: { flex: 1 },
  shortcut: { opacity: 0.6 },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
  footerCompact: { paddingHorizontal: spacing.sm, alignItems: 'center' },
  main: { flex: 1, minWidth: 0 },
});

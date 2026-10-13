/** Small building blocks used across SGM screens. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { radius, spacing, toneColors, useTheme, type Tone } from './theme';

export function Card({
  title,
  action,
  children,
  style,
  padded = true,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, padded && styles.padded, style]}>
      {title || action ? (
        <View style={[styles.cardHeader, !padded && styles.cardHeaderUnpadded]}>
          {title ? (
            <Text variant="subheading" style={styles.flex}>
              {title}
            </Text>
          ) : (
            <View style={styles.flex} />
          )}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Badge({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const { colors } = useTheme();
  const { fg, bg } = toneColors(colors, tone);
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={13} color={fg} /> : null}
      <Text variant="small" color={fg} weight="600" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Banner({ tone = 'info', children, icon }: { tone?: Tone; children: ReactNode; icon?: IconName }) {
  const { colors } = useTheme();
  const { fg, bg } = toneColors(colors, tone);
  const defaultIcon: IconName =
    tone === 'danger' ? 'alert-circle-outline' : tone === 'warning' ? 'warning-outline' : tone === 'success' ? 'checkmark-circle-outline' : 'information-circle-outline';
  return (
    <View style={[styles.banner, { backgroundColor: bg }]} accessibilityRole="alert">
      <Icon name={icon ?? defaultIcon} color={fg} />
      <Text color={fg} style={styles.flex}>
        {children}
      </Text>
    </View>
  );
}

export interface SegmentOption<V extends string> {
  label: string;
  value: V;
}

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  size = 'md',
  accessibilityLabel,
}: {
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.segments, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              size === 'sm' ? styles.segmentSm : styles.segmentMd,
              active && { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text variant={size === 'sm' ? 'small' : 'body'} weight={active ? '700' : '500'} color={active ? colors.text : colors.textMuted}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ScreenHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <View style={styles.screenHeader}>
      <View style={styles.flex}>
        <Text variant="heading">{title}</Text>
        {subtitle ? <Text muted>{subtitle}</Text> : null}
      </View>
      {actions ? <View style={styles.headerActions}>{actions}</View> : null}
    </View>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: IconName;
  tone?: Tone;
}) {
  const { colors } = useTheme();
  const { fg, bg } = toneColors(colors, tone === 'neutral' ? 'info' : tone);
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.statIcon, { backgroundColor: bg }]}>
        <Icon name={icon} size={20} color={fg} />
      </View>
      <View style={styles.flex}>
        <Text variant="small" muted>
          {label}
        </Text>
        <Text variant="heading" numeric numberOfLines={1}>
          {value}
        </Text>
        {hint ? (
          <Text variant="small" color={tone === 'neutral' ? colors.textMuted : fg}>
            {hint}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function EmptyState({ icon, title, message }: { icon: IconName; title: string; message?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={32} color={colors.textMuted} />
      <Text weight="600">{title}</Text>
      {message ? (
        <Text muted align="center">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { borderWidth: 1, borderRadius: radius.lg, gap: spacing.md },
  padded: { padding: spacing.lg },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardHeaderUnpadded: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  segments: { flexDirection: 'row', borderWidth: 1, borderRadius: radius.md, padding: 2, alignSelf: 'flex-start' },
  segment: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  segmentSm: { paddingHorizontal: spacing.sm, paddingVertical: 3 },
  segmentMd: { paddingHorizontal: spacing.md, paddingVertical: 6 },
  screenHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap', flexShrink: 1, maxWidth: '100%' },
  stat: {
    flexGrow: 1,
    flexBasis: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  statIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
});

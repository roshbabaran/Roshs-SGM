import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { fontSize, radius, spacing, useTheme } from './theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** Keyboard shortcut shown on desktop, e.g. "F9". The screen wires the key itself. */
  shortcut?: string;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

const heights: Record<Size, number> = { sm: 32, md: 40, lg: 52 };

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  disabled,
  loading,
  shortcut,
  fullWidth,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  const inactive = disabled || loading;

  const palette: Record<Variant, { bg: string; hover: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, hover: colors.primaryPressed, fg: colors.primaryText, border: colors.primary },
    secondary: { bg: colors.surface, hover: colors.surfaceMuted, fg: colors.text, border: colors.border },
    ghost: { bg: 'transparent', hover: colors.surfaceMuted, fg: colors.primary, border: 'transparent' },
    danger: { bg: colors.danger, hover: colors.danger, fg: '#FFFFFF', border: colors.danger },
  };
  const p = palette[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.base,
        {
          height: heights[size],
          paddingHorizontal: size === 'sm' ? spacing.md : spacing.lg,
          backgroundColor: hovered || pressed ? p.hover : p.bg,
          borderColor: p.border,
          opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={p.fg} />
      ) : (
        icon && <Icon name={icon} size={size === 'lg' ? 20 : 16} color={p.fg} />
      )}
      <Text
        color={p.fg}
        weight="600"
        style={{ fontSize: size === 'lg' ? fontSize.lg : size === 'sm' ? fontSize.sm : fontSize.md }}
        numberOfLines={1}
      >
        {title}
      </Text>
      {shortcut && Platform.OS === 'web' ? (
        <View style={[styles.shortcut, { borderColor: p.fg }]}>
          <Text variant="small" color={p.fg} style={styles.shortcutText}>
            {shortcut}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    cursor: 'pointer',
  },
  fullWidth: { alignSelf: 'stretch' },
  shortcut: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    opacity: 0.75,
  },
  shortcutText: { fontSize: 11 },
});

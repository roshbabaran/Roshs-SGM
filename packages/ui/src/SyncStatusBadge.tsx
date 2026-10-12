import type { SyncStatus } from '@sgm/core';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { radius, spacing, toneColors, useTheme, type Tone } from './theme';

export function describeSync(status: SyncStatus): { label: string; icon: IconName; tone: Tone } {
  const review = status.rejected > 0 ? ` · ${status.rejected} need review` : '';
  switch (status.state) {
    case 'syncing':
      return { label: 'Syncing…', icon: 'sync-outline', tone: 'info' };
    case 'offline':
      return {
        label: status.pending > 0 ? `Offline · ${status.pending} waiting` : 'Offline',
        icon: 'cloud-offline-outline',
        tone: 'warning',
      };
    case 'error':
      return { label: `Sync problem${review}`, icon: 'alert-circle-outline', tone: 'danger' };
    case 'signed-out':
      return { label: 'Not signed in', icon: 'cloud-outline', tone: 'neutral' };
    default:
      if (status.rejected > 0) return { label: `${status.rejected} need review`, icon: 'alert-circle-outline', tone: 'danger' };
      if (status.pending > 0) return { label: `${status.pending} to sync`, icon: 'cloud-upload-outline', tone: 'warning' };
      return { label: 'All synced', icon: 'cloud-done-outline', tone: 'success' };
  }
}

/** Always-visible sync state. Pressing it syncs now. `compact` shows the icon only. */
export function SyncStatusBadge({ status, onPress, compact }: { status: SyncStatus; onPress?: () => void; compact?: boolean }) {
  const { colors } = useTheme();
  const { label, icon, tone } = describeSync(status);
  const { fg, bg } = toneColors(colors, tone);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Sync status: ${label}. Press to sync now.`}
      style={[styles.badge, { backgroundColor: bg }]}
    >
      {status.state === 'syncing' ? <ActivityIndicator size="small" color={fg} /> : <Icon name={icon} size={16} color={fg} />}
      {compact ? null : (
        <Text variant="small" weight="600" color={fg} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    cursor: 'pointer',
  },
});

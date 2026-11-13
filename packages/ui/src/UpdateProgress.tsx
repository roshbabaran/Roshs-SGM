/**
 * How far along the update download is, as a bar with the percentage and megabytes. Shows nothing while no update
 * is downloading, or where the app can't report its download.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { UpdateDownload } from './services';
import { useServices } from './services-context';
import { Text } from './Text';
import { radius, spacing, useTheme } from './theme';

const MB = 1024 * 1024;
const megabytes = (bytes: number) => (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0);

/** The download in progress, or null. */
export function useUpdateDownload(): UpdateDownload | null {
  const { updates } = useServices();
  const [download, setDownload] = useState<UpdateDownload | null>(null);
  useEffect(() => updates?.watchDownload?.(setDownload), [updates]);
  return download;
}

export function UpdateProgress({ style }: { style?: StyleProp<ViewStyle> }) {
  const { appName } = useServices();
  const { colors } = useTheme();
  const download = useUpdateDownload();
  if (!download) return null;

  const { version, received, total } = download;
  const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
  const what = `${appName}${version ? ` ${version}` : ''}`;
  const label = percent === 100 ? `Downloaded ${what}` : `Downloading ${what}…`;
  const amount = total ? `${percent}% · ${megabytes(received)} of ${megabytes(total)} MB` : `${megabytes(received)} MB`;

  return (
    <View
      style={[styles.root, style]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={percent === null ? { text: amount } : { min: 0, max: 100, now: percent }}
    >
      <View style={styles.labels}>
        <Text variant="small" weight="600" style={styles.flex} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="small" muted>
          {amount}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
        {/* Without a size from the server, a short bar marks that the download is moving. */}
        <View style={[styles.fill, { backgroundColor: colors.primary, width: `${percent ?? 15}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', gap: spacing.xs },
  labels: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
  track: { height: 10, borderRadius: radius.pill, borderWidth: 1, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },
});

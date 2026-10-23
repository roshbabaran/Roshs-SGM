import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { useServices } from './services-context';
import { Text } from './Text';
import { monoFont, spacing } from './theme';

/** This device's ID, which the owner or an admin needs to approve it in Users & Devices, with a button to copy it. */
export function DeviceIdField() {
  const { deviceId, copyText } = useServices();
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await copyText!(deviceId);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <View style={styles.row}>
      <Text style={styles.id} selectable accessibilityLabel={`Device ID ${deviceId}`}>
        {deviceId}
      </Text>
      {copyText ? (
        <Button
          title={copied === 'yes' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
          icon={copied === 'yes' ? 'checkmark' : 'copy-outline'}
          variant="secondary"
          size="sm"
          onPress={() => void copy()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  id: { fontFamily: monoFont, flexShrink: 1 },
});

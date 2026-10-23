import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { useServices } from './services-context';
import { Text } from './Text';
import { monoFont, radius, spacing, useTheme } from './theme';

/**
 * Shown in place of a page that failed, instead of the app closing: what went
 * wrong, to copy and send to whoever looks after SGM, with Try again and Sign
 * out. The apps' pages after sign-in export it as their ErrorBoundary.
 */
export function ScreenError({ error, retry }: { error: Error; retry: () => void | Promise<void> }) {
  const { appName, appVersion, copyText, session } = useServices();
  const { colors } = useTheme();
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const summary = `${error.name}: ${error.message}`;
  // The stack's first line usually repeats the message.
  const stack = (error.stack ?? '').split('\n').filter((line, i) => !(i === 0 && line.trim() === summary));
  const details = [`${appName} ${appVersion}`, summary, ...stack.slice(0, 6)].join('\n');

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Draws the page again too, so a failed layout can send the person to the sign-in page.
  const signOut = async () => {
    await session.logout();
    await retry();
  };

  const copy = async () => {
    try {
      await copyText!(details);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.root, { backgroundColor: colors.background }]}>
      <Text variant="heading">This page ran into a problem</Text>
      <Text muted>
        {`${appName} kept your work. Try again, or sign out and back in. If it keeps happening, copy the details and send them to whoever looks after SGM.`}
      </Text>
      <View style={styles.actions}>
        <Button title="Try again" icon="refresh" onPress={() => void retry()} />
        {copyText ? (
          <Button
            title={copied === 'yes' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy details'}
            icon={copied === 'yes' ? 'checkmark' : 'copy-outline'}
            variant="secondary"
            onPress={() => void copy()}
          />
        ) : null}
        <Button title="Sign out" icon="log-out-outline" variant="secondary" onPress={() => void signOut()} />
      </View>
      <View style={[styles.details, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
        <Text style={styles.mono} selectable>
          {details}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md, maxWidth: 720, width: '100%', alignSelf: 'center' },
  details: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  mono: { fontFamily: monoFont, fontSize: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});

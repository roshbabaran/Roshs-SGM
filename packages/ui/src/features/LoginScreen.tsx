import { ApiError, DEMO_ACCOUNTS, loginFormSchema } from '@sgm/core';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Banner, Card } from '../Basics';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useServices } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useZodForm } from '../useZodForm';

export function LoginScreen() {
  const { session, api, appName } = useServices();
  const { colors } = useTheme();
  const form = useZodForm(loginFormSchema, { username: '', pin: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<TextInput>(null);

  const submit = form.handleSubmit(async ({ username, pin }) => {
    setBusy(true);
    setError(null);
    try {
      await session.login(username, pin);
    } catch (e) {
      setError(
        e instanceof ApiError && e.kind === 'network'
          ? "Can't reach the SGM server. Signing in needs a connection; once signed in, this device works offline."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          <View style={styles.brand}>
            <View style={[styles.logo, { backgroundColor: colors.accent }]}>
              <Icon name="flame" size={26} color="#FFFFFF" />
            </View>
            <View>
              <Text variant="heading">{appName}</Text>
              <Text muted>Sibugay Gas Marketing</Text>
            </View>
          </View>

          <TextField
            label="Username"
            value={form.values.username}
            onChangeText={(v) => form.set('username', v)}
            error={form.errors.username}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => pinRef.current?.focus()}
          />
          <TextField
            ref={pinRef}
            label="PIN"
            value={form.values.pin}
            onChangeText={(v) => form.set('pin', v.replace(/\D/g, ''))}
            error={form.errors.pin}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={8}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Button title="Sign in" size="lg" onPress={submit} loading={busy} fullWidth />

          {api.mode === 'demo' ? (
            <View style={[styles.demo, { borderTopColor: colors.border }]}>
              <Text variant="small" muted>
                Demo accounts (no server connected yet). Tap one to fill it in:
              </Text>
              <View style={styles.demoRow}>
                {DEMO_ACCOUNTS.map((account) => (
                  <Pressable
                    key={account.username}
                    accessibilityRole="button"
                    onPress={() => {
                      form.set('username', account.username);
                      form.set('pin', account.pin);
                    }}
                    style={[styles.chip, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
                  >
                    <Text variant="small" weight="600">
                      {account.username} · {account.pin}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: { width: '100%', maxWidth: 400, gap: spacing.lg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  logo: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  demo: { borderTopWidth: 1, paddingTop: spacing.md, gap: spacing.sm },
  demoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6, cursor: 'pointer' },
});

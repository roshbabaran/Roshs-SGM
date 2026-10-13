import { formatPeso, PAYMENT_LABELS, PAYMENT_METHODS, parsePeso, paymentFormSchema, type Centavos, type Payment } from '@sgm/core';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Banner, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useZodForm } from '../useZodForm';

const EMPTY = { method: 'cash' as const, tendered: '', reference: '' };

/** Suggested cash amounts: exact, then the next ₱100, ₱500 and ₱1,000. */
function quickAmounts(total: Centavos): Centavos[] {
  const up = (step: number) => Math.ceil(total / step) * step;
  return Array.from(new Set([total, up(10_000), up(50_000), up(100_000)])).filter((a) => a >= total);
}

export function PaymentDialog({
  visible,
  total,
  onCancel,
  onConfirm,
  title = 'Payment',
  confirmLabel = 'Complete sale',
  cancelLabel = 'Back to sale',
}: {
  visible: boolean;
  total: Centavos;
  onCancel: () => void;
  /** Saves the sale; if it throws, the message is shown here and nothing is lost. */
  onConfirm: (payment: Payment) => Promise<void>;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  const { colors } = useTheme();
  const schema = useMemo(() => paymentFormSchema(total), [total]);
  const form = useZodForm(schema, EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reset } = form;

  useEffect(() => {
    if (visible) {
      reset(EMPTY);
      setError(null);
    }
  }, [visible, reset]);

  const cash = parsePeso(form.values.tendered);
  const change = form.values.method === 'cash' && cash !== null && cash >= total ? cash - total : null;

  const submit = form.handleSubmit(async (payment) => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(payment);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog
      visible={visible}
      title={title}
      onClose={onCancel}
      width={460}
      dismissable={!busy}
      actions={
        <>
          <Button title={cancelLabel} variant="secondary" onPress={onCancel} disabled={busy} />
          <Button title={confirmLabel} icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      <View style={[styles.total, { backgroundColor: colors.primarySoft }]}>
        <Text muted>Amount due</Text>
        <Text variant="title" numeric color={colors.primary}>
          {formatPeso(total)}
        </Text>
      </View>

      <SegmentedControl
        accessibilityLabel="Payment method"
        options={PAYMENT_METHODS.map((m) => ({ label: PAYMENT_LABELS[m], value: m }))}
        value={form.values.method}
        onChange={(method) => form.set('method', method)}
      />

      {form.values.method === 'cash' ? (
        <>
          <TextField
            label="Cash received"
            prefix="₱"
            value={form.values.tendered}
            onChangeText={(v) => form.set('tendered', v)}
            error={form.errors.tendered}
            keyboardType="decimal-pad"
            autoFocus
            onSubmitEditing={submit}
          />
          <View style={styles.quick}>
            {quickAmounts(total).map((amount) => (
              <Pressable
                key={amount}
                accessibilityRole="button"
                onPress={() => form.set('tendered', (amount / 100).toFixed(2))}
                style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}
              >
                <Text variant="small" weight="600">
                  {amount === total ? `Exact ${formatPeso(amount)}` : formatPeso(amount)}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.changeRow}>
            <Text muted>Change</Text>
            <Text variant="subheading" numeric>
              {change === null ? '—' : formatPeso(change)}
            </Text>
          </View>
        </>
      ) : (
        <TextField
          label={`${PAYMENT_LABELS[form.values.method]} reference number`}
          value={form.values.reference}
          onChangeText={(v) => form.set('reference', v)}
          error={form.errors.reference}
          autoCapitalize="characters"
          autoFocus
          onSubmitEditing={submit}
        />
      )}

      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  total: { borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', gap: 2 },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6, cursor: 'pointer' },
  changeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});

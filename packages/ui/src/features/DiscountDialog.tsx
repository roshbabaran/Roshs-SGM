import { discountedPrice, discountFormSchema, formatPeso, type Centavos, type Discount } from '@sgm/core';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useZodForm } from '../useZodForm';

/** A discount on one cart line: a percentage off, or a lower price for each. Needs pos.discount. */
export function DiscountDialog({
  visible,
  name,
  regular,
  current,
  onApply,
  onClose,
}: {
  visible: boolean;
  name: string;
  /** One unit's regular price. */
  regular: Centavos;
  /** The discount the cashier gave this line already. */
  current?: Discount;
  onApply: (discount: Discount | undefined) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const schema = useMemo(() => discountFormSchema(regular), [regular]);
  const form = useZodForm(schema, { kind: 'percent', value: '' });
  const { reset } = form;

  useEffect(() => {
    if (!visible) return;
    if (current?.kind === 'price') reset({ kind: 'price', value: (current.price / 100).toFixed(2) });
    else reset({ kind: 'percent', value: current ? String(current.percent) : '' });
  }, [visible, current, reset]);

  const preview = schema.safeParse(form.values);
  const price = preview.success ? discountedPrice(regular, preview.data) : null;
  const apply = form.handleSubmit((discount) => onApply(discount));

  return (
    <Dialog
      visible={visible}
      title={`Discount: ${name}`}
      onClose={onClose}
      width={420}
      actions={
        <>
          {current ? <Button title="Remove discount" variant="ghost" onPress={() => onApply(undefined)} /> : null}
          <Button title="Cancel" variant="secondary" onPress={onClose} />
          <Button title="Apply" icon="checkmark" onPress={apply} />
        </>
      }
    >
      <Text muted>Regular price {formatPeso(regular)} each.</Text>
      <SegmentedControl
        accessibilityLabel="Discount type"
        options={[
          { label: 'Percent off', value: 'percent' },
          { label: 'Price each', value: 'price' },
        ]}
        value={form.values.kind}
        onChange={(kind) => form.set('kind', kind)}
      />
      <TextField
        label={form.values.kind === 'percent' ? 'Percent off' : 'Price for each'}
        prefix={form.values.kind === 'price' ? '₱' : undefined}
        placeholder={form.values.kind === 'percent' ? '10' : (regular / 100).toFixed(2)}
        value={form.values.value}
        onChangeText={(v) => form.set('value', v)}
        error={form.errors.value}
        keyboardType="decimal-pad"
        autoFocus
        onSubmitEditing={apply}
      />
      <View style={[styles.preview, { backgroundColor: colors.successSoft }]}>
        <Text muted>New price each</Text>
        <Text variant="subheading" numeric color={colors.success}>
          {price === null ? '—' : `${formatPeso(price)} (less ${formatPeso(regular - price)})`}
        </Text>
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  preview: { borderRadius: radius.md, padding: spacing.md, gap: 2 },
});

import {
  localDay,
  MANUAL_MOVEMENT_TYPES,
  MOVEMENT_LABELS,
  movementFormSchema,
  recordMovement,
  type Product,
} from '@sgm/core';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { z } from 'zod';

import { Banner, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { DateField } from '../DateField';
import { Dialog } from '../Dialog';
import { Select } from '../Select';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { useToast } from '../Toast';
import { useZodForm } from '../useZodForm';

type MovementForm = z.input<typeof movementFormSchema>;

const blankForm = (): MovementForm => ({
  type: 'DELIVERY_IN',
  productId: '',
  condition: 'full',
  direction: 'add',
  qty: '',
  reason: '',
  day: localDay(new Date()),
  counterpartLocationId: '',
});

/** Records a delivery, transfer, count adjustment, damaged cylinder or return. */
export function MovementDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { data: products } = useCollection<Product>('products');
  const form = useZodForm(movementFormSchema, blankForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reset } = form;

  useEffect(() => {
    if (visible) {
      reset(blankForm());
      setError(null);
    }
  }, [visible, reset]);

  const product = products.find((p) => p.id === form.values.productId);
  const isTransfer = form.values.type === 'TRANSFER_IN' || form.values.type === 'TRANSFER_OUT';
  const needsReason = ['ADJUSTMENT', 'DAMAGED', 'RETURN_TO_SUPPLIER'].includes(form.values.type);

  const submit = form.handleSubmit(async (input) => {
    setBusy(true);
    setError(null);
    try {
      await recordMovement(work.ctx, input);
      toast.show(`${MOVEMENT_LABELS[input.type]} saved.`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog
      visible={visible}
      title="Record stock movement"
      onClose={onClose}
      dismissable={!busy}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Save" icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      <Text muted>At {work.location?.name ?? 'this location'}. Stock is never typed over; each change is recorded with who, when and why.</Text>
      <Select
        label="What happened"
        value={form.values.type}
        options={MANUAL_MOVEMENT_TYPES.map((t) => ({ label: MOVEMENT_LABELS[t], value: t }))}
        onChange={(type) => form.set('type', type)}
        error={form.errors.type}
      />
      <Select
        label="Product"
        value={form.values.productId}
        options={products.filter((p) => p.active).map((p) => ({ label: p.name, value: p.id, hint: p.sku }))}
        onChange={(productId) => {
          form.set('productId', productId);
          const picked = products.find((p) => p.id === productId);
          form.set('condition', picked?.kind === 'accessory' ? 'unit' : 'full');
        }}
        error={form.errors.productId}
      />
      {product?.kind === 'cylinder' ? (
        <View>
          <Text variant="label">Cylinders</Text>
          <SegmentedControl
            options={[
              { label: 'Full', value: 'full' },
              { label: 'Empty', value: 'empty' },
            ]}
            value={form.values.condition === 'empty' ? 'empty' : 'full'}
            onChange={(condition) => form.set('condition', condition)}
          />
        </View>
      ) : null}
      {form.values.type === 'ADJUSTMENT' ? (
        <View>
          <Text variant="label">Counted stock is</Text>
          <SegmentedControl
            options={[
              { label: 'More than recorded', value: 'add' },
              { label: 'Less than recorded', value: 'remove' },
            ]}
            value={form.values.direction}
            onChange={(direction) => form.set('direction', direction)}
          />
        </View>
      ) : null}
      <TextField
        label="Quantity"
        value={form.values.qty}
        onChangeText={(v) => form.set('qty', v.replace(/\D/g, ''))}
        error={form.errors.qty}
        keyboardType="number-pad"
      />
      {isTransfer ? (
        <Select
          label={form.values.type === 'TRANSFER_OUT' ? 'Sent to' : 'Received from'}
          value={form.values.counterpartLocationId}
          options={work.locations.filter((l) => l.id !== work.locationId).map((l) => ({ label: l.name, value: l.id }))}
          onChange={(id) => form.set('counterpartLocationId', id)}
          error={form.errors.counterpartLocationId}
        />
      ) : null}
      <DateField label="Date" value={form.values.day} onChange={(day) => form.set('day', day)} error={form.errors.day} max={localDay(new Date())} />
      <TextField
        label={needsReason ? 'Reason (required)' : 'Note (optional)'}
        value={form.values.reason}
        onChangeText={(v) => form.set('reason', v)}
        error={form.errors.reason}
        multiline
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

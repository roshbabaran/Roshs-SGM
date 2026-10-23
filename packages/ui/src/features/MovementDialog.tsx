import {
  localDay,
  MANUAL_MOVEMENT_TYPES,
  MOVEMENT_LABELS,
  movementFormSchema,
  recordMovement,
  type ManualMovementType,
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

const blankForm = (start?: MovementStart, products: Product[] = []): MovementForm => ({
  type: start?.type ?? 'DELIVERY_IN',
  productId: start?.productId ?? '',
  condition: products.find((p) => p.id === start?.productId)?.kind === 'accessory' ? 'unit' : 'full',
  direction: 'add',
  qty: '',
  reason: '',
  day: localDay(new Date()),
  counterpartLocationId: '',
});

/** What the dialog opens with, e.g. an adjustment of the product clicked on the dashboard. */
export interface MovementStart {
  type?: ManualMovementType;
  productId?: string;
}

/** Records stock from or to the depot, stock sent to another branch, an adjustment or stock found defective. */
export function MovementDialog({ visible, onClose, start }: { visible: boolean; onClose: () => void; start?: MovementStart }) {
  const work = useWork();
  const toast = useToast();
  const { data: products } = useCollection<Product>('products');
  const form = useZodForm(movementFormSchema, blankForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reset } = form;

  // Opening (or a different start) fills the form once; later product list updates don't clear what was typed.
  const startKey = `${start?.type ?? ''}|${start?.productId ?? ''}`;
  useEffect(() => {
    if (visible) {
      reset(blankForm(start, products));
      setError(null);
    }
  }, [visible, reset, startKey]);

  const product = products.find((p) => p.id === form.values.productId);
  const good = product?.kind === 'accessory' ? 'unit' : 'full';
  // Depot stock comes in good condition, and marking stock defective takes it from a good count.
  const defectiveAllowed = form.values.type !== 'DELIVERY_IN' && form.values.type !== 'DAMAGED';
  const conditions = [
    ...(product?.kind === 'accessory'
      ? [{ label: 'In stock', value: 'unit' as const }]
      : [
          { label: 'Full', value: 'full' as const },
          { label: 'Empty', value: 'empty' as const },
        ]),
    ...(defectiveAllowed ? [{ label: 'Defective', value: 'defective' as const }] : []),
  ];
  const isTransfer = form.values.type === 'TRANSFER_OUT';
  const needsReason = ['ADJUSTMENT', 'DAMAGED', 'RETURN_TO_SUPPLIER'].includes(form.values.type);

  const submit = form.handleSubmit(async (input) => {
    setBusy(true);
    setError(null);
    try {
      await recordMovement(work.ctx, input);
      const to = work.locations.find((l) => l.id === input.counterpartLocationId)?.name;
      toast.show(input.type === 'TRANSFER_OUT' ? `Stocks Out saved. It waits at ${to ?? 'the other branch'} until it is accepted there.` : `${MOVEMENT_LABELS[input.type]} saved.`, 'success');
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
      title={start?.productId ? 'Stock adjustment' : 'Record stock movement'}
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
        onChange={(type) => {
          form.set('type', type);
          if ((type === 'DELIVERY_IN' || type === 'DAMAGED') && form.values.condition === 'defective') form.set('condition', good);
        }}
        error={form.errors.type}
      />
      <Select
        label="Product"
        value={form.values.productId}
        options={products.filter((p) => p.active).map((p) => ({ label: p.name, value: p.id, hint: p.sku }))}
        searchable
        searchPlaceholder="Search products by name or SKU"
        onChange={(productId) => {
          form.set('productId', productId);
          const picked = products.find((p) => p.id === productId);
          form.set('condition', picked?.kind === 'accessory' ? 'unit' : 'full');
        }}
        error={form.errors.productId}
      />
      {product && conditions.length > 1 ? (
        <View>
          <Text variant="label">{form.values.type === 'DAMAGED' ? 'Taken from' : product.kind === 'cylinder' ? 'Cylinders' : 'Stock'}</Text>
          <SegmentedControl
            options={conditions}
            value={conditions.some((c) => c.value === form.values.condition) ? form.values.condition : good}
            onChange={(condition) => form.set('condition', condition)}
          />
        </View>
      ) : null}
      {form.values.type === 'DAMAGED' ? (
        <Text muted>It moves to the defective count, where it waits until it goes back to the depot.</Text>
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
        <>
          <Select
            label="Sent to"
            value={form.values.counterpartLocationId}
            options={work.locations.filter((l) => l.id !== work.locationId).map((l) => ({ label: l.name, value: l.id }))}
            onChange={(id) => form.set('counterpartLocationId', id)}
            error={form.errors.counterpartLocationId}
          />
          <Text muted>
            It leaves the stock here now, and waits at the other branch until its manager or warehouse staff, an admin or the owner counts it and accepts it.
          </Text>
        </>
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

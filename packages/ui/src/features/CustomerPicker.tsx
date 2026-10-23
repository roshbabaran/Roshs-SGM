import { describeDiscount, tidyName, type Customer, type CustomerRef, type Product, type ProductSet } from '@sgm/core';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Badge, Banner, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Icon } from '../Icon';
import { useCollection } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';

/** Customers whose name or phone number has the search text in it, by name. */
export function searchCustomers(customers: Customer[], query: string): Customer[] {
  const q = query.trim().toLowerCase();
  return customers
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone ?? '').replace(/\s/g, '').includes(q.replace(/\s/g, '')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Picks a customer from the list, or adds a new one by name (and phone).
 * A new customer is saved with the sale, so nothing is added if the sale is cancelled.
 */
export function CustomerPickerDialog({
  visible,
  title = 'Customer',
  onPick,
  onClose,
}: {
  visible: boolean;
  title?: string;
  onPick: (customer: CustomerRef) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const { data: customers } = useCollection<Customer>('borrowers');
  const { data: products } = useCollection<Product>('products');
  const { data: sets } = useCollection<ProductSet>('sets');
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMode('list');
      setQuery('');
      setName('');
      setPhone('');
      setError(null);
    }
  }, [visible]);

  const productsById = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));
  const shown = searchCustomers(customers, query).slice(0, 50);

  const addNew = () => {
    const tidy = tidyName(name);
    if (tidy.length < 2) return setError("Enter the customer's name.");
    const existing = customers.find((c) => c.name.toLowerCase() === tidy.toLowerCase());
    if (existing) return setError(`${existing.name} is already on the list. Choose them instead.`);
    onPick({ name: tidy, phone: phone.trim() || undefined });
  };

  return (
    <Dialog
      visible={visible}
      title={title}
      onClose={onClose}
      width={480}
      actions={
        mode === 'new' ? (
          <>
            <Button title="Back to list" variant="secondary" onPress={() => setMode('list')} />
            <Button title="Use this name" icon="checkmark" onPress={addNew} />
          </>
        ) : undefined
      }
    >
      <SegmentedControl
        accessibilityLabel="Customer"
        options={[
          { label: 'On the list', value: 'list' },
          { label: 'New customer', value: 'new' },
        ]}
        value={mode}
        onChange={(next) => {
          setMode(next);
          if (next === 'new' && !name) setName(query);
          setError(null);
        }}
      />
      {mode === 'list' ? (
        <>
          <TextField placeholder="Search by name or phone" value={query} onChangeText={setQuery} autoFocus />
          <View>
            {shown.map((c) => {
              const discount = describeDiscount(c.discount, productsById, setsById);
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  onPress={() => onPick({ id: c.id, name: c.name })}
                  style={({ pressed }) => [styles.option, { backgroundColor: pressed ? colors.surfaceMuted : 'transparent' }]}
                >
                  <Icon name="person-circle-outline" color={colors.textMuted} />
                  <View style={styles.optionText}>
                    <Text weight="600">{c.name}</Text>
                    {c.phone ? (
                      <Text variant="small" muted>
                        {c.phone}
                      </Text>
                    ) : null}
                    {discount ? (
                      <Text variant="small" color={colors.success}>
                        {discount}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            {shown.length === 0 ? (
              <View style={styles.none}>
                <Text muted>{query ? `No customer matches “${query}”.` : 'No customers yet.'}</Text>
                <Button
                  title={query ? `Add “${tidyName(query)}”` : 'Add a customer'}
                  icon="person-add-outline"
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    setName(query);
                    setMode('new');
                  }}
                />
              </View>
            ) : null}
          </View>
        </>
      ) : (
        <>
          <TextField label="Name" value={name} onChangeText={setName} autoFocus autoCapitalize="words" />
          <TextField label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" onSubmitEditing={addNew} />
          {error ? <Banner tone="danger">{error}</Banner> : null}
        </>
      )}
    </Dialog>
  );
}

/** The customer a sale is for, with buttons to choose, change or remove them. */
export function CustomerField({
  customer,
  onChoose,
  onClear,
  required,
  discountText,
}: {
  customer: CustomerRef | null;
  onChoose: () => void;
  onClear?: () => void;
  /** Shown in red when the sale needs a name and has none. */
  required?: boolean;
  /** The customer's standing discount, when they have one. */
  discountText?: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.field, { borderColor: required && !customer ? colors.danger : colors.border, backgroundColor: colors.surfaceMuted }]}>
      <Icon name={customer ? 'person' : 'person-outline'} color={customer ? colors.primary : colors.textMuted} size={18} />
      <View style={styles.optionText}>
        <Text weight={customer ? '600' : '400'} muted={!customer} numberOfLines={1}>
          {customer ? customer.name : required ? 'Choose the customer' : 'No customer name'}
        </Text>
        {customer && !customer.id ? (
          <Text variant="small" muted>
            New customer, saved with the sale
          </Text>
        ) : null}
        {discountText ? <Badge label={discountText} tone="success" icon="pricetag-outline" /> : null}
      </View>
      <Button title={customer ? 'Change' : 'Add name'} variant="ghost" size="sm" onPress={onChoose} />
      {customer && onClear ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Remove the customer" onPress={onClear} style={styles.clear}>
          <Icon name="close" size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    cursor: 'pointer',
  },
  optionText: { flex: 1, gap: 2 },
  none: { gap: spacing.sm, alignItems: 'flex-start', padding: spacing.sm },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 42,
  },
  clear: { padding: spacing.xs, cursor: 'pointer' },
});

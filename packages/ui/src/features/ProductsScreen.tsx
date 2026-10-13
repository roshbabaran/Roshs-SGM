import {
  describeSet,
  formatPeso,
  parsePeso,
  productFormSchema,
  regularPrice,
  saveProduct,
  saveSet,
  setFormSchema,
  type Centavos,
  type Product,
  type ProductSet,
  type SetItemType,
} from '@sgm/core';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { z } from 'zod';

import { Badge, Banner, Card, ScreenHeader, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { Dialog } from '../Dialog';
import { Icon } from '../Icon';
import { Select } from '../Select';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useToast } from '../Toast';
import { useZodForm } from '../useZodForm';

/** Centavos as typed in a price box: 95000 becomes "950", 95050 becomes "950.50". */
const pesoInput = (amount: Centavos | undefined) => (amount === undefined ? '' : amount % 100 === 0 ? String(amount / 100) : (amount / 100).toFixed(2));

const statusBadge = (active: boolean) => <Badge label={active ? 'For sale' : 'Hidden'} tone={active ? 'success' : 'neutral'} />;

const productColumns: Column<Product>[] = [
  { key: 'name', title: 'Name', flex: 2, text: (p) => p.name },
  { key: 'sku', title: 'Code', width: 190, text: (p) => p.sku },
  { key: 'kind', title: 'Type', width: 150, text: (p) => (p.kind === 'cylinder' ? `Cylinder · ${p.sizeKg ?? '?'} kg` : 'Accessory') },
  {
    key: 'refill',
    title: 'Refill',
    width: 110,
    align: 'right',
    text: (p) => (p.kind === 'cylinder' ? formatPeso(p.refillPrice ?? p.price) : '—'),
    sortValue: (p) => p.refillPrice ?? 0,
  },
  { key: 'price', title: 'New / price', width: 120, align: 'right', text: (p) => formatPeso(p.price), sortValue: (p) => p.price },
  { key: 'low', title: 'Low at', width: 80, align: 'right', text: (p) => String(p.lowStockAt), sortValue: (p) => p.lowStockAt },
  { key: 'active', title: 'Status', width: 100, sortValue: (p) => (p.active ? 0 : 1), render: (p) => statusBadge(p.active) },
];

/** The owner's list of products and sets, with their prices. */
export function ProductsScreen() {
  const { data: products } = useCollection<Product>('products');
  const { data: sets } = useCollection<ProductSet>('sets');
  const [tab, setTab] = useState<'products' | 'sets'>('products');
  const [editingProduct, setEditingProduct] = useState<Product | 'new' | null>(null);
  const [editingSet, setEditingSet] = useState<ProductSet | 'new' | null>(null);
  const byId = new Map(products.map((p) => [p.id, p]));

  const setColumns: Column<ProductSet>[] = [
    { key: 'name', title: 'Name', flex: 1.4, text: (s) => s.name },
    { key: 'items', title: 'Contains', flex: 3, text: (s) => describeSet(s, byId) },
    { key: 'price', title: 'Set price', width: 110, align: 'right', text: (s) => formatPeso(s.price), sortValue: (s) => s.price },
    {
      key: 'regular',
      title: 'One by one',
      width: 120,
      align: 'right',
      text: (s) => formatPeso(regularPrice(s, byId)),
      sortValue: (s) => regularPrice(s, byId),
    },
    {
      key: 'saving',
      title: 'Saving',
      width: 110,
      align: 'right',
      text: (s) => formatPeso(regularPrice(s, byId) - s.price),
      sortValue: (s) => regularPrice(s, byId) - s.price,
    },
    { key: 'active', title: 'Status', width: 100, sortValue: (s) => (s.active ? 0 : 1), render: (s) => statusBadge(s.active) },
  ];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Products"
        subtitle="What the branches sell, the prices, and the sets."
        actions={
          tab === 'products' ? (
            <Button title="Add product" icon="add" onPress={() => setEditingProduct('new')} />
          ) : (
            <Button title="Add set" icon="add" onPress={() => setEditingSet('new')} />
          )
        }
      />
      <SegmentedControl
        accessibilityLabel="Show"
        options={[
          { label: `Products (${products.length})`, value: 'products' },
          { label: `Sets (${sets.length})`, value: 'sets' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Card padded>
        {tab === 'products' ? (
          <DataTable
            rows={products}
            columns={productColumns}
            rowKey={(p) => p.id}
            onRowPress={setEditingProduct}
            searchPlaceholder="Search products"
            initialSort={{ key: 'name', direction: 'asc' }}
            minWidth={860}
          />
        ) : (
          <DataTable
            rows={sets}
            columns={setColumns}
            rowKey={(s) => s.id}
            onRowPress={setEditingSet}
            searchPlaceholder="Search sets"
            emptyText="No sets yet. Add one to sell items together for less."
            minWidth={900}
          />
        )}
        <Text variant="small" muted>
          Click a row to change it. Products and sets that are no longer sold can be hidden; their past sales stay in the records.
        </Text>
      </Card>
      <ProductDialog editing={editingProduct} onClose={() => setEditingProduct(null)} />
      <SetDialog editing={editingSet} products={products} onClose={() => setEditingSet(null)} />
    </ScrollView>
  );
}

type ProductForm = z.input<typeof productFormSchema>;

const blankProduct = (): ProductForm => ({
  kind: 'cylinder',
  name: '',
  sku: '',
  brand: '',
  sizeKg: '',
  refillPrice: '',
  price: '',
  lowStockAt: '5',
  active: true,
});

const productToForm = (p: Product): ProductForm => ({
  kind: p.kind,
  name: p.name,
  sku: p.sku,
  brand: p.brand ?? '',
  sizeKg: p.sizeKg === undefined ? '' : String(p.sizeKg),
  refillPrice: pesoInput(p.refillPrice),
  price: pesoInput(p.price),
  lowStockAt: String(p.lowStockAt),
  active: p.active,
});

function ProductDialog({ editing, onClose }: { editing: Product | 'new' | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const form = useZodForm(productFormSchema, blankProduct());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reset } = form;
  const product = editing === 'new' ? null : editing;

  useEffect(() => {
    if (editing) {
      reset(editing === 'new' ? blankProduct() : productToForm(editing));
      setError(null);
    }
  }, [editing, reset]);

  const v = form.values;
  const cylinder = v.kind === 'cylinder';
  const refill = parsePeso(v.refillPrice);
  const newPrice = parsePeso(v.price);
  const cylinderPart = refill !== null && newPrice !== null && newPrice > refill ? newPrice - refill : null;

  const submit = form.handleSubmit(async (input) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveProduct(work.ctx, input, product?.id);
      toast.show(product ? `${saved.name} saved.` : `${saved.name} added. Record a delivery in Inventory to give it stock.`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog
      visible={!!editing}
      title={product ? `Change ${product.name}` : 'Add product'}
      onClose={onClose}
      dismissable={!busy}
      width={560}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title={product ? 'Save' : 'Add product'} icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      {product ? (
        <Text muted>{product.kind === 'cylinder' ? 'Cylinder' : 'Accessory'} · code {product.sku}</Text>
      ) : (
        <View style={styles.field}>
          <Text variant="label">Type</Text>
          <SegmentedControl
            options={[
              { label: 'Cylinder (LPG)', value: 'cylinder' },
              { label: 'Accessory', value: 'accessory' },
            ]}
            value={v.kind}
            onChange={(kind) => form.set('kind', kind)}
          />
        </View>
      )}
      <TextField
        label="Name"
        value={v.name}
        onChangeText={(text) => form.set('name', text)}
        error={form.errors.name}
        placeholder={cylinder ? 'e.g. Brand C 11 kg' : 'e.g. LPG regulator'}
        autoFocus={!product}
      />
      {product ? null : (
        <TextField
          label="Code (optional)"
          value={v.sku}
          onChangeText={(text) => form.set('sku', text)}
          error={form.errors.sku}
          hint="Leave it blank and SGM makes one from the name."
          autoCapitalize="characters"
        />
      )}
      {cylinder ? (
        <View style={styles.pair}>
          <TextField
            label="Brand"
            value={v.brand}
            onChangeText={(text) => form.set('brand', text)}
            error={form.errors.brand}
            containerStyle={styles.half}
          />
          <TextField
            label="Size (kg)"
            value={v.sizeKg}
            onChangeText={(text) => form.set('sizeKg', text.replace(/[^\d.]/g, ''))}
            error={form.errors.sizeKg}
            keyboardType="decimal-pad"
            containerStyle={styles.half}
          />
        </View>
      ) : null}
      {cylinder ? (
        <View style={styles.pair}>
          <TextField
            label="Refill price"
            prefix="₱"
            value={v.refillPrice}
            onChangeText={(text) => form.set('refillPrice', text)}
            error={form.errors.refillPrice}
            hint="The customer swaps an empty for a full cylinder."
            keyboardType="decimal-pad"
            containerStyle={styles.half}
          />
          <TextField
            label="New cylinder price"
            prefix="₱"
            value={v.price}
            onChangeText={(text) => form.set('price', text)}
            error={form.errors.price}
            hint={
              cylinderPart !== null && refill !== null
                ? `Cylinder ${formatPeso(cylinderPart)} + content ${formatPeso(refill)}`
                : 'A full cylinder with no empty in return.'
            }
            keyboardType="decimal-pad"
            containerStyle={styles.half}
          />
        </View>
      ) : (
        <TextField
          label="Price"
          prefix="₱"
          value={v.price}
          onChangeText={(text) => form.set('price', text)}
          error={form.errors.price}
          keyboardType="decimal-pad"
        />
      )}
      <TextField
        label="Low-stock warning at"
        value={v.lowStockAt}
        onChangeText={(text) => form.set('lowStockAt', text.replace(/\D/g, ''))}
        error={form.errors.lowStockAt}
        hint={cylinder ? 'Warn when full cylinders drop to this many or fewer.' : 'Warn when units drop to this many or fewer.'}
        keyboardType="number-pad"
      />
      <View style={styles.field}>
        <Text variant="label">At the counter</Text>
        <SegmentedControl
          options={[
            { label: 'For sale', value: 'yes' },
            { label: 'Hidden', value: 'no' },
          ]}
          value={v.active ? 'yes' : 'no'}
          onChange={(value) => form.set('active', value === 'yes')}
        />
      </View>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

type SetForm = z.input<typeof setFormSchema>;

const blankSet = (): SetForm => ({ name: '', items: [{ productId: '', type: 'refill', qty: '1' }], price: '', active: true });

const setToForm = (s: ProductSet): SetForm => ({
  name: s.name,
  items: s.items.map((item) => ({ productId: item.productId, type: item.type, qty: String(item.qty) })),
  price: pesoInput(s.price),
  active: s.active,
});

function SetDialog({ editing, products, onClose }: { editing: ProductSet | 'new' | null; products: Product[]; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
  const form = useZodForm(setFormSchema, blankSet());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reset } = form;
  const set = editing === 'new' ? null : editing;
  const byId = new Map(products.map((p) => [p.id, p]));

  useEffect(() => {
    if (editing) {
      reset(editing === 'new' ? blankSet() : setToForm(editing));
      setError(null);
    }
  }, [editing, reset]);

  const items = form.values.items;
  const setItems = (next: SetForm['items']) => form.set('items', next);
  const changeItem = (index: number, patch: Partial<SetForm['items'][number]>) =>
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const typed = items.flatMap((item) => {
    const qty = parseInt(item.qty, 10);
    return item.productId && qty > 0 ? [{ productId: item.productId, type: item.type, qty }] : [];
  });
  const regular = regularPrice({ items: typed }, byId);
  const price = parsePeso(form.values.price);

  const submit = form.handleSubmit(async (input) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveSet(work.ctx, input, set?.id);
      toast.show(`${saved.name} ${set ? 'saved' : 'added'}.`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  const productOptions = products
    .filter((p) => p.active || items.some((item) => item.productId === p.id))
    .map((p) => ({
      label: p.name,
      value: p.id,
      hint: p.kind === 'cylinder' ? `Refill ${formatPeso(p.refillPrice ?? p.price)} · New ${formatPeso(p.price)}` : formatPeso(p.price),
    }));

  return (
    <Dialog
      visible={!!editing}
      title={set ? `Change ${set.name}` : 'Add set'}
      onClose={onClose}
      dismissable={!busy}
      width={640}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title={set ? 'Save' : 'Add set'} icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      <TextField
        label="Name"
        value={form.values.name}
        onChangeText={(text) => form.set('name', text)}
        error={form.errors.name}
        placeholder="e.g. Starter kit 11 kg"
        autoFocus={!set}
      />
      <View style={styles.field}>
        <Text variant="label">What's in the set</Text>
        {items.map((item, index) => {
          const product = byId.get(item.productId);
          return (
            <View key={index} style={[styles.itemRow, { borderColor: colors.border }]}>
              <View style={styles.itemProduct}>
                <Select
                  value={item.productId}
                  options={productOptions}
                  placeholder="Choose a product…"
                  onChange={(productId) => {
                    const picked = byId.get(productId);
                    changeItem(index, { productId, type: picked?.kind === 'accessory' ? 'item' : item.type === 'item' ? 'refill' : item.type });
                  }}
                />
              </View>
              {product?.kind === 'cylinder' ? (
                <SegmentedControl<SetItemType>
                  size="sm"
                  accessibilityLabel="Sold as"
                  options={[
                    { label: 'Refill', value: 'refill' },
                    { label: 'New', value: 'new' },
                  ]}
                  value={item.type === 'new' ? 'new' : 'refill'}
                  onChange={(type) => changeItem(index, { type })}
                />
              ) : null}
              <TextField
                value={item.qty}
                onChangeText={(text) => changeItem(index, { qty: text.replace(/\D/g, '') })}
                keyboardType="number-pad"
                accessibilityLabel="Quantity"
                containerStyle={styles.qty}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove this item"
                onPress={() => setItems(items.filter((_, i) => i !== index))}
                style={styles.remove}
              >
                <Icon name="trash-outline" color={colors.danger} />
              </Pressable>
            </View>
          );
        })}
        {form.errors.items ? (
          <Text variant="small" color={colors.danger}>
            {form.errors.items}
          </Text>
        ) : null}
        <View style={styles.addRow}>
          <Button title="Add item" icon="add" variant="secondary" size="sm" onPress={() => setItems([...items, { productId: '', type: 'refill', qty: '1' }])} />
        </View>
      </View>
      <TextField
        label="Set price"
        prefix="₱"
        value={form.values.price}
        onChangeText={(text) => form.set('price', text)}
        error={form.errors.price}
        hint={
          regular > 0
            ? price !== null && price < regular
              ? `Bought one by one: ${formatPeso(regular)}. Customers save ${formatPeso(regular - price)}.`
              : `Bought one by one: ${formatPeso(regular)}. Set the price lower so the set is a deal.`
            : undefined
        }
        keyboardType="decimal-pad"
      />
      <View style={styles.field}>
        <Text variant="label">At the counter</Text>
        <SegmentedControl
          options={[
            { label: 'For sale', value: 'yes' },
            { label: 'Hidden', value: 'no' },
          ]}
          value={form.values.active ? 'yes' : 'no'}
          onChange={(value) => form.set('active', value === 'yes')}
        />
      </View>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  field: { gap: spacing.xs },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  half: { flexGrow: 1, flexBasis: 200 },
  itemRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  itemProduct: { flexGrow: 1, flexBasis: 220 },
  qty: { width: 70 },
  remove: { padding: spacing.xs, cursor: 'pointer' },
  addRow: { flexDirection: 'row' },
});

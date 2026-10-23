import {
  containsSet,
  describeDiscount,
  describeSet,
  describeSetParts,
  discountTargets,
  formatPeso,
  parsePeso,
  productFormSchema,
  regularPrice,
  saveCustomer,
  saveProduct,
  saveSet,
  setFormSchema,
  setsContaining,
  suggestedSetPrice,
  type Centavos,
  type Customer,
  type Product,
  type ProductKind,
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

/** A cylinder's own price, without the gas: what a new cylinder costs over a refill. */
const cylinderOnly = (p: Product) => p.price - (p.refillPrice ?? p.price);

const productColumns: Column<Product>[] = [
  { key: 'name', title: 'Name', flex: 2, text: (p) => p.name },
  { key: 'sku', title: 'Code', width: 170, text: (p) => p.sku },
  { key: 'kind', title: 'Type', width: 140, text: (p) => (p.kind === 'cylinder' ? `Cylinder · ${p.sizeKg ?? '?'} kg` : 'Accessory') },
  {
    key: 'refill',
    title: 'Refill',
    width: 110,
    align: 'right',
    text: (p) => (p.kind === 'cylinder' ? formatPeso(p.refillPrice ?? p.price) : '—'),
    sortValue: (p) => p.refillPrice ?? 0,
  },
  {
    key: 'cylinder',
    title: 'Cylinder',
    width: 110,
    align: 'right',
    text: (p) => (p.kind === 'cylinder' ? formatPeso(cylinderOnly(p)) : '—'),
    sortValue: (p) => (p.kind === 'cylinder' ? cylinderOnly(p) : 0),
  },
  { key: 'price', title: 'New / price', width: 120, align: 'right', text: (p) => formatPeso(p.price), sortValue: (p) => p.price },
  { key: 'low', title: 'Low at', width: 80, align: 'right', text: (p) => String(p.lowStockAt), sortValue: (p) => p.lowStockAt },
  { key: 'active', title: 'Status', width: 100, sortValue: (p) => (p.active ? 0 : 1), render: (p) => statusBadge(p.active) },
];

type Tab = 'products' | 'sets' | 'customers';
type KindFilter = 'all' | ProductKind | 'hidden';

/** The owner's list of products and sets, with their prices, and the customers given their own prices. */
export function ProductsScreen() {
  const { data: products } = useCollection<Product>('products');
  const { data: sets } = useCollection<ProductSet>('sets');
  const { data: customers } = useCollection<Customer>('borrowers');
  const [tab, setTab] = useState<Tab>('products');
  const [kind, setKind] = useState<KindFilter>('all');
  const [editingProduct, setEditingProduct] = useState<Product | 'new' | null>(null);
  const [editingSet, setEditingSet] = useState<ProductSet | 'new' | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | 'new' | null>(null);
  const byId = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));
  const count = (k: KindFilter) => products.filter((p) => (k === 'all' ? true : k === 'hidden' ? !p.active : p.kind === k)).length;
  const shownProducts = products.filter((p) => (kind === 'all' ? true : kind === 'hidden' ? !p.active : p.kind === kind));

  const setColumns: Column<ProductSet>[] = [
    { key: 'name', title: 'Name', flex: 1.4, text: (s) => s.name },
    { key: 'items', title: 'Contains', flex: 3, text: (s) => describeSetParts(s, byId, setsById) },
    { key: 'price', title: 'Set price', width: 110, align: 'right', text: (s) => formatPeso(s.price), sortValue: (s) => s.price },
    {
      key: 'regular',
      title: 'One by one',
      width: 120,
      align: 'right',
      text: (s) => formatPeso(regularPrice(s, byId, setsById)),
      sortValue: (s) => regularPrice(s, byId, setsById),
    },
    {
      key: 'saving',
      title: 'Saving',
      width: 110,
      align: 'right',
      text: (s) => formatPeso(regularPrice(s, byId, setsById) - s.price),
      sortValue: (s) => regularPrice(s, byId, setsById) - s.price,
    },
    { key: 'active', title: 'Status', width: 100, sortValue: (s) => (s.active ? 0 : 1), render: (s) => statusBadge(s.active) },
  ];

  const customerColumns: Column<Customer>[] = [
    { key: 'name', title: 'Customer', flex: 1.2, text: (c) => c.name },
    { key: 'phone', title: 'Phone', width: 150, text: (c) => c.phone ?? '' },
    { key: 'discount', title: 'Their prices', flex: 2.5, text: (c) => describeDiscount(c.discount, byId, setsById) || 'Regular prices' },
  ];
  const withPrices = customers.filter((c) => c.discount).length;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Products"
        subtitle="What the branches sell, the prices, and the sets."
        actions={
          tab === 'products' ? (
            <Button title="Add product" icon="add" onPress={() => setEditingProduct('new')} />
          ) : tab === 'sets' ? (
            <Button title="Add set" icon="add" onPress={() => setEditingSet('new')} />
          ) : (
            <Button title="Add customer" icon="person-add-outline" onPress={() => setEditingCustomer('new')} />
          )
        }
      />
      <SegmentedControl
        accessibilityLabel="Show"
        options={[
          { label: `Products (${products.length})`, value: 'products' },
          { label: `Sets (${sets.length})`, value: 'sets' },
          { label: `Customer prices (${withPrices})`, value: 'customers' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Card padded>
        {tab === 'products' ? (
          <DataTable
            rows={shownProducts}
            columns={productColumns}
            rowKey={(p) => p.id}
            onRowPress={setEditingProduct}
            searchPlaceholder="Search products"
            initialSort={{ key: 'name', direction: 'asc' }}
            minWidth={960}
            emptyText={kind === 'hidden' ? 'No hidden products.' : 'No products of this type yet.'}
            toolbar={
              <SegmentedControl<KindFilter>
                size="sm"
                accessibilityLabel="Type of product"
                options={[
                  { label: `All (${count('all')})`, value: 'all' },
                  { label: `Cylinders (${count('cylinder')})`, value: 'cylinder' },
                  { label: `Accessories (${count('accessory')})`, value: 'accessory' },
                  { label: `Hidden (${count('hidden')})`, value: 'hidden' },
                ]}
                value={kind}
                onChange={setKind}
              />
            }
          />
        ) : tab === 'sets' ? (
          <DataTable
            rows={sets}
            columns={setColumns}
            rowKey={(s) => s.id}
            onRowPress={setEditingSet}
            searchPlaceholder="Search sets"
            emptyText="No sets yet. Add one to sell items together for less."
            minWidth={900}
          />
        ) : (
          <DataTable
            rows={customers}
            columns={customerColumns}
            rowKey={(c) => c.id}
            onRowPress={setEditingCustomer}
            searchPlaceholder="Search customers"
            emptyText="No customers yet. They are added when a sale names them, or here."
            initialSort={{ key: 'name', direction: 'asc' }}
            minWidth={720}
          />
        )}
        <Text variant="small" muted>
          {tab === 'customers'
            ? "Click a customer to give them a percentage off everything or their own price for particular products and sets. It applies whenever a sale names them."
            : 'Click a row to change it. Products and sets that are no longer sold can be hidden; their past sales stay in the records.'}
        </Text>
      </Card>
      <ProductDialog editing={editingProduct} onClose={() => setEditingProduct(null)} />
      <SetDialog editing={editingSet} products={products} sets={sets} onClose={() => setEditingSet(null)} />
      <CustomerPricesDialog editing={editingCustomer} products={products} sets={sets} onClose={() => setEditingCustomer(null)} />
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
  cylinderPrice: '',
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
  cylinderPrice: p.kind === 'cylinder' ? pesoInput(cylinderOnly(p)) : '',
  price: pesoInput(p.price),
  lowStockAt: String(p.lowStockAt),
  active: p.active,
});

function ProductDialog({ editing, onClose }: { editing: Product | 'new' | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
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
  const cylinderPart = parsePeso(v.cylinderPrice);
  const newPrice = refill !== null && cylinderPart !== null ? refill + cylinderPart : null;

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
            label="Cylinder price"
            prefix="₱"
            value={v.cylinderPrice}
            onChangeText={(text) => form.set('cylinderPrice', text)}
            error={form.errors.cylinderPrice}
            hint="The empty cylinder by itself, without the gas."
            keyboardType="decimal-pad"
            containerStyle={styles.half}
          />
        </View>
      ) : null}
      {cylinder ? (
        <View style={[styles.computed, { backgroundColor: colors.primarySoft }]}>
          <Text muted>New cylinder with refill (no empty in return)</Text>
          <Text variant="subheading" numeric color={colors.primary}>
            {newPrice === null ? '—' : formatPeso(newPrice)}
          </Text>
          {newPrice !== null ? (
            <Text variant="small" muted numeric>
              Cylinder {formatPeso(cylinderPart ?? 0)} + refill {formatPeso(refill ?? 0)}
            </Text>
          ) : null}
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

const blankSet = (): SetForm => ({ name: '', items: [{ productId: '', type: 'refill', qty: '1' }], sets: [], price: '', active: true });

/** What the form holds, leaving out rows that aren't filled in yet. */
const contentsOf = (items: SetForm['items'], nested: NonNullable<SetForm['sets']>) => ({
  items: items.flatMap((item) => {
    const qty = parseInt(item.qty, 10);
    return item.productId && qty > 0 ? [{ productId: item.productId, type: item.type, qty }] : [];
  }),
  sets: nested.flatMap((row) => {
    const qty = parseInt(row.qty, 10);
    return row.setId && qty > 0 ? [{ setId: row.setId, qty }] : [];
  }),
});

const setToForm = (s: ProductSet): SetForm => ({
  name: s.name,
  items: s.items.map((item) => ({ productId: item.productId, type: item.type, qty: String(item.qty) })),
  sets: (s.sets ?? []).map((nested) => ({ setId: nested.setId, qty: String(nested.qty) })),
  price: pesoInput(s.price),
  active: s.active,
});

function SetDialog({
  editing,
  products,
  sets,
  onClose,
}: {
  editing: ProductSet | 'new' | null;
  products: Product[];
  sets: ProductSet[];
  onClose: () => void;
}) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
  const form = useZodForm(setFormSchema, blankSet());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Once the owner types a price it stays; until then it follows what the set holds. */
  const [priceTyped, setPriceTyped] = useState(false);
  const { reset } = form;
  const set = editing === 'new' ? null : editing;
  const byId = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));

  useEffect(() => {
    if (editing) {
      reset(editing === 'new' ? blankSet() : setToForm(editing));
      setPriceTyped(editing !== 'new');
      setError(null);
    }
  }, [editing, reset]);

  const items = form.values.items;
  const nested = form.values.sets ?? [];
  // The price follows the contents until the owner types their own.
  const changeContents = (nextItems: SetForm['items'], nextNested: NonNullable<SetForm['sets']>) => {
    form.set('items', nextItems);
    form.set('sets', nextNested);
    if (!priceTyped) {
      const next = suggestedSetPrice(contentsOf(nextItems, nextNested), byId, setsById);
      form.set('price', next > 0 ? pesoInput(next) : '');
    }
  };
  const setItems = (next: SetForm['items']) => changeContents(next, nested);
  const setNested = (next: NonNullable<SetForm['sets']>) => changeContents(items, next);
  const changeItem = (index: number, patch: Partial<SetForm['items'][number]>) =>
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const changeNested = (index: number, patch: Partial<NonNullable<SetForm['sets']>[number]>) =>
    setNested(nested.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const typed = contentsOf(items, nested);
  // Savings are measured against every product at its regular price, sets inside opened up.
  const regular = regularPrice(typed, byId, setsById);
  const suggested = suggestedSetPrice(typed, byId, setsById);
  const price = parsePeso(form.values.price);
  const affected = set ? setsContaining(set.id, sets) : [];

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
  // A set can't go inside itself, or inside a set that is already inside it.
  const setOptions = sets
    .filter((s) => !set || (s.id !== set.id && !containsSet(s, set.id, setsById)))
    .filter((s) => s.active || nested.some((row) => row.setId === s.id))
    .map((s) => ({ label: s.name, value: s.id, hint: `${formatPeso(s.price)} · ${describeSet(s, byId, setsById)}` }));

  return (
    <Dialog
      visible={!!editing}
      title={set ? `Change ${set.name}` : 'Add set'}
      onClose={onClose}
      dismissable={!busy}
      width={680}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title={set ? 'Save' : 'Add set'} icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      {affected.length > 0 ? (
        <Banner tone="warning">
          {`${set?.name} is inside ${affected.length === 1 ? 'another set' : `${affected.length} other sets`}: ${affected
            .map((s) => s.name)
            .join(', ')}. Changing what is in it changes ${affected.length === 1 ? 'that set' : 'those sets'} too. Their prices stay as they are; check them after saving.`}
        </Banner>
      ) : null}
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
        {nested.map((row, index) => {
          const inner = setsById.get(row.setId);
          return (
            <View key={`set-${index}`} style={[styles.itemRow, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
              <Icon name="gift-outline" color={colors.primary} />
              <View style={styles.itemProduct}>
                <Select value={row.setId} options={setOptions} placeholder="Choose a set…" onChange={(setId) => changeNested(index, { setId })} />
              </View>
              <TextField
                value={row.qty}
                onChangeText={(text) => changeNested(index, { qty: text.replace(/\D/g, '') })}
                keyboardType="number-pad"
                accessibilityLabel="Quantity"
                containerStyle={styles.qty}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove this set"
                onPress={() => setNested(nested.filter((_, i) => i !== index))}
                style={styles.remove}
              >
                <Icon name="trash-outline" color={colors.danger} />
              </Pressable>
              {inner ? (
                <Text variant="small" muted style={styles.inside}>
                  {`Holds ${describeSet(inner, byId, setsById)} (set price ${formatPeso(inner.price)})`}
                </Text>
              ) : null}
            </View>
          );
        })}
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
        {form.errors.items || form.errors.sets ? (
          <Text variant="small" color={colors.danger}>
            {form.errors.items ?? form.errors.sets}
          </Text>
        ) : null}
        <View style={styles.addRow}>
          <Button title="Add item" icon="add" variant="secondary" size="sm" onPress={() => setItems([...items, { productId: '', type: 'refill', qty: '1' }])} />
          <Button
            title="Add set"
            icon="gift-outline"
            variant="secondary"
            size="sm"
            onPress={() => setNested([...nested, { setId: '', qty: '1' }])}
            disabled={setOptions.length === 0}
          />
        </View>
        {typed.sets.length > 0 ? (
          <Text variant="small" muted>
            {`At the counter it shows as ${describeSet(typed, byId, setsById) || 'its items'}.`}
          </Text>
        ) : null}
      </View>
      <TextField
        label="Set price"
        prefix="₱"
        value={form.values.price}
        onChangeText={(text) => {
          setPriceTyped(true);
          form.set('price', text);
        }}
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
      {priceTyped && suggested > 0 && price !== suggested ? (
        <View style={styles.addRow}>
          <Button
            title={`Use ${formatPeso(suggested)}${typed.sets.length > 0 ? ' (items, plus the sets inside at their set prices)' : ' (the items at their prices)'}`}
            variant="ghost"
            size="sm"
            onPress={() => {
              setPriceTyped(false);
              form.set('price', pesoInput(suggested));
            }}
          />
        </View>
      ) : null}
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

interface PriceRow {
  key: string;
  price: string;
}

/** The owner gives a customer a percentage off everything, or their own price for particular products and sets. */
function CustomerPricesDialog({
  editing,
  products,
  sets,
  onClose,
}: {
  editing: Customer | 'new' | null;
  products: Product[];
  sets: ProductSet[];
  onClose: () => void;
}) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
  const customer = editing === 'new' ? null : editing;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [percent, setPercent] = useState('');
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const current = editing === 'new' ? null : editing;
    setName(current?.name ?? '');
    setPhone(current?.phone ?? '');
    setPercent(current?.discount?.percent ? String(current.discount.percent) : '');
    setRows(Object.entries(current?.discount?.prices ?? {}).map(([key, price]) => ({ key, price: pesoInput(price) })));
    setError(null);
  }, [editing]);

  const targets = discountTargets(
    products.filter((p) => p.active || rows.some((r) => r.key.startsWith(`${p.id}:`))),
    sets.filter((s) => s.active || rows.some((r) => r.key === `set:${s.id}`)),
  );
  const regularOf = (key: string) => targets.find((t) => t.key === key)?.regular;

  const save = async () => {
    setError(null);
    const pct = percent.trim() ? Number(percent) : 0;
    if (percent.trim() && (!/^\d+(\.\d{1,2})?$/.test(percent.trim()) || pct <= 0 || pct >= 100)) {
      return setError('Enter a percentage from 1 to 99, like 5, or leave it blank.');
    }
    const prices: Record<string, number> = {};
    for (const row of rows) {
      if (!row.key) return setError('Choose a product or set for every price, or remove the row.');
      const price = parsePeso(row.price);
      const regular = regularOf(row.key) ?? 0;
      if (price === null) return setError('Enter a price for every row, like 900.');
      if (price >= regular) return setError(`Each price must be less than the regular ${formatPeso(regular)}.`);
      prices[row.key] = price;
    }
    setBusy(true);
    try {
      const saved = await saveCustomer(work.ctx, {
        id: customer?.id,
        name,
        phone,
        discount: { ...(pct ? { percent: pct } : {}), prices },
      });
      toast.show(`${saved.name} saved.`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={!!editing}
      title={customer ? customer.name : 'Add customer'}
      onClose={onClose}
      dismissable={!busy}
      width={600}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Save" icon="checkmark" onPress={save} loading={busy} />
        </>
      }
    >
      <View style={styles.pair}>
        <TextField label="Name" value={name} onChangeText={setName} containerStyle={styles.half} autoFocus={!customer} autoCapitalize="words" />
        <TextField label="Phone (optional)" value={phone} onChangeText={setPhone} containerStyle={styles.half} keyboardType="phone-pad" />
      </View>
      <TextField
        label="Percent off everything (optional)"
        value={percent}
        onChangeText={setPercent}
        keyboardType="decimal-pad"
        hint="Applies to anything without its own price below."
      />
      <View style={styles.field}>
        <Text variant="label">Their own prices</Text>
        {rows.map((row, index) => {
          const regular = regularOf(row.key);
          return (
            <View key={index} style={[styles.itemRow, { borderColor: colors.border }]}>
              <View style={styles.itemProduct}>
                <Select
                  value={row.key}
                  options={targets
                    .filter((t) => t.key === row.key || !rows.some((r) => r.key === t.key))
                    .map((t) => ({ label: t.label, value: t.key, hint: `Regular ${formatPeso(t.regular)}` }))}
                  placeholder="Choose a product or set…"
                  onChange={(key) => setRows(rows.map((r, i) => (i === index ? { ...r, key } : r)))}
                />
              </View>
              <TextField
                prefix="₱"
                value={row.price}
                onChangeText={(price) => setRows(rows.map((r, i) => (i === index ? { ...r, price } : r)))}
                keyboardType="decimal-pad"
                accessibilityLabel="Their price"
                containerStyle={styles.price}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove this price"
                onPress={() => setRows(rows.filter((_, i) => i !== index))}
                style={styles.remove}
              >
                <Icon name="trash-outline" color={colors.danger} />
              </Pressable>
              {regular !== undefined ? (
                <Text variant="small" muted style={styles.inside}>
                  {`Regular ${formatPeso(regular)}`}
                </Text>
              ) : null}
            </View>
          );
        })}
        <View style={styles.addRow}>
          <Button title="Add a price" icon="add" variant="secondary" size="sm" onPress={() => setRows([...rows, { key: '', price: '' }])} />
        </View>
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
  price: { width: 130 },
  remove: { padding: spacing.xs, cursor: 'pointer' },
  addRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  inside: { flexBasis: '100%' },
  computed: { borderRadius: radius.md, padding: spacing.md, gap: 2 },
});

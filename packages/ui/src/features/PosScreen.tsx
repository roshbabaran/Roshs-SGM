import {
  addSetToCart,
  addToCart,
  ALLOW_NEGATIVE_STOCK,
  cartDemand,
  cartLineKey,
  changeQty,
  changeType,
  checkSlipNo,
  describeSet,
  findShortages,
  formatPeso,
  isLowStock,
  levelOf,
  priceCart,
  productUnits,
  recordSale,
  regularPrice,
  sellable,
  stockByProduct,
  type CartLine,
  type Payment,
  type Product,
  type ProductKind,
  type ProductLineType,
  type ProductSet,
  type Sale,
  type SaleLine,
  type Shortage,
  type StockLevel,
  type StockMovement,
} from '@sgm/core';
import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Badge, Card, EmptyState, ScreenHeader, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useCollection, useServices, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useToast } from '../Toast';
import { useBreakpoint } from '../useBreakpoint';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { PaymentDialog } from './PaymentDialog';
import { ReceiptScanDialog, type ScannedSale } from './ReceiptScanDialog';
import { ReceiptDialog } from './receipts';

type Section = 'all' | ProductKind | 'set';

const SECTIONS: { label: string; value: Section }[] = [
  { label: 'All', value: 'all' },
  { label: 'Cylinders', value: 'cylinder' },
  { label: 'Accessories', value: 'accessory' },
  { label: 'Sets', value: 'set' },
];

/** Product cards fill the row: as many columns as fit at this width or wider. */
const MIN_CARD_WIDTH = 200;

/**
 * The counter screen: pick products or sets, choose refill or new cylinder, take payment, print.
 * Where the device can read receipts, a handwritten receipt can be scanned into the cart instead.
 */
export function PosScreen() {
  const work = useWork();
  const { ocr } = useServices();
  const toast = useToast();
  const { isWide } = useBreakpoint();
  const { data: products } = useCollection<Product>('products');
  const { data: sets } = useCollection<ProductSet>('sets');
  const { data: movements } = useCollection<StockMovement>('movements');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<Section>('all');
  const [paying, setPaying] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** The number of the handwritten receipt the cart was scanned from. */
  const [slipNo, setSlipNo] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const searchRef = useRef<TextInput>(null);

  const columns = Math.max(1, Math.floor((gridWidth + spacing.md) / (MIN_CARD_WIDTH + spacing.md)));
  const cardWidth = gridWidth > 0 ? Math.floor((gridWidth - spacing.md * (columns - 1)) / columns) : MIN_CARD_WIDTH;

  const byId = new Map(products.map((p) => [p.id, p]));
  // A set can be sold only while every product in it still exists.
  const setsById = new Map(sets.filter((set) => set.items.every((item) => byId.has(item.productId))).map((set) => [set.id, set]));
  const levels = stockByProduct(movements, work.locationId);
  const lines = cart.filter((line) => (line.type === 'set' ? setsById.has(line.setId) : byId.has(line.productId)));
  const { lines: priced, total } = priceCart(lines, byId, setsById);
  const demand = cartDemand(productUnits(lines, setsById));
  const q = query.trim().toLowerCase();
  const shownProducts =
    section === 'set'
      ? []
      : products.filter(
          (p) => p.active && (section === 'all' || p.kind === section) && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)),
        );
  const shownSets = section === 'set' ? Array.from(setsById.values()).filter((set) => set.active && (!q || set.name.toLowerCase().includes(q))) : [];
  const where = work.location?.name ?? 'this branch';

  const shortagesOf = (next: CartLine[]): Shortage[] => (ALLOW_NEGATIVE_STOCK ? [] : findShortages(next, byId, levels, setsById));

  /** The change this would make to the cart pushes some stock below zero, or null if it fits. */
  const newShortage = (next: CartLine[]): Shortage | null => {
    const before = shortagesOf(lines);
    return (
      shortagesOf(next).find((s) => {
        const was = before.find((b) => b.productId === s.productId && b.condition === s.condition);
        return !was || s.needed > was.needed;
      }) ?? null
    );
  };

  const stockMessage = (shortage: Shortage) => {
    if (shortage.condition !== 'empty') return `No more ${shortage.name} in stock at ${where}.`;
    const product = byId.get(shortage.productId)?.name ?? '';
    return `A new ${product} also takes an empty cylinder from the shelf, and ${where} has ${shortage.available} left.`;
  };

  /** Every change to the cart comes through here. An emptied cart forgets the scanned receipt. */
  const replaceCart = (next: CartLine[]) => {
    setCart(next);
    if (next.length === 0) setSlipNo(null);
  };

  const update = (next: CartLine[]) => {
    const shortage = newShortage(next);
    if (shortage) toast.show(stockMessage(shortage), 'error');
    else replaceCart(next);
  };

  const add = (product: Product) => update(addToCart(lines, product));
  const addSet = (set: ProductSet) => update(addSetToCart(lines, set));

  const indexOf = (line: CartLine) => lines.findIndex((l) => cartLineKey(l) === cartLineKey(line));

  const setQty = (line: CartLine, qty: number) => {
    const next = changeQty(lines, indexOf(line), qty);
    if (qty > line.qty) update(next);
    else replaceCart(next);
  };

  const setType = (line: CartLine, type: ProductLineType) => update(changeType(lines, indexOf(line), type));

  const charge = () => {
    if (lines.length > 0) setPaying(true);
  };

  const complete = async (payment: Payment) => {
    const sale = await recordSale(work.ctx, { cart: lines, payment, slipNo: slipNo ?? undefined });
    replaceCart([]);
    setPaying(false);
    setLastSale(sale);
  };

  /**
   * The lines the cashier confirmed from a scanned receipt become the cart. A
   * receipt number that was already entered is caught here, while the dialog
   * still lets the cashier correct it.
   */
  const applyScan = async (scanned: ScannedSale) => {
    const shortage = shortagesOf(scanned.cart)[0];
    if (shortage) throw new Error(stockMessage(shortage));
    if (scanned.slipNo) await checkSlipNo(work.ctx, scanned.slipNo);
    replaceCart(scanned.cart);
    setSlipNo(scanned.slipNo ?? null);
    setScanning(false);
  };

  const finishReceipt = () => {
    setLastSale(null);
    searchRef.current?.focus();
  };

  useKeyboardShortcuts(
    {
      F2: () => searchRef.current?.focus(),
      F4: () => replaceCart([]),
      F9: charge,
    },
    !paying && !lastSale && !scanning,
  );

  const catalog = (
    <View style={styles.catalog}>
      <View style={styles.toolbar}>
        <TextField
          ref={searchRef}
          placeholder={Platform.OS === 'web' ? `Search ${section === 'set' ? 'sets' : 'products'} (F2)` : `Search ${section === 'set' ? 'sets' : 'products'}`}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => {
            if (shownProducts.length === 1 && shownSets.length === 0) add(shownProducts[0]);
            if (shownSets.length === 1 && shownProducts.length === 0) addSet(shownSets[0]);
          }}
          containerStyle={styles.search}
          accessibilityLabel="Search products"
        />
        <SegmentedControl options={SECTIONS} value={section} onChange={setSection} accessibilityLabel="Show" />
      </View>
      <ScrollView
        onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}
        contentContainerStyle={[styles.grid, !isWide && styles.list]}
      >
        {shownProducts.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            level={levelOf(levels, product.id)}
            inCart={demand.get(product.id) ?? 0}
            onPress={() => add(product)}
            row={!isWide}
            width={cardWidth}
          />
        ))}
        {shownSets.map((set) => (
          <SetCard
            key={set.id}
            set={set}
            products={byId}
            available={shortagesOf(addSetToCart([], set)).length === 0}
            inCart={lines.find((line) => line.type === 'set' && line.setId === set.id)?.qty ?? 0}
            onPress={() => addSet(set)}
            row={!isWide}
            width={cardWidth}
          />
        ))}
        {section === 'set' && shownSets.length === 0 ? (
          <EmptyState
            icon="gift-outline"
            title={q ? 'No sets match' : 'No sets yet'}
            message={q ? 'Try another name.' : 'The owner adds sets on the Products page.'}
          />
        ) : null}
        {section !== 'set' && shownProducts.length === 0 ? (
          <EmptyState icon="search-outline" title="No products match" message="Try another name or type." />
        ) : null}
      </ScrollView>
    </View>
  );

  const cartPanel = (
    <CartPanel
      lines={lines}
      priced={priced}
      products={byId}
      total={total}
      slipNo={lines.length > 0 ? slipNo : null}
      onQty={setQty}
      onType={setType}
      onClear={() => replaceCart([])}
      onCharge={charge}
      compact={!isWide}
    />
  );

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Sell"
        subtitle={[work.location?.name, work.user?.displayName].filter(Boolean).join(' · ')}
        actions={
          Platform.OS === 'web' || ocr ? (
            <>
              {Platform.OS === 'web' ? (
                <Text variant="small" muted>
                  F2 search · F4 clear · F9 charge
                </Text>
              ) : null}
              {ocr ? <Button title="Scan receipt" icon="scan-outline" variant="secondary" size="sm" onPress={() => setScanning(true)} /> : null}
            </>
          ) : null
        }
      />
      {isWide ? (
        <View style={styles.wide}>
          {catalog}
          <View style={styles.cartColumn}>{cartPanel}</View>
        </View>
      ) : (
        <View style={styles.narrow}>
          {catalog}
          {cartPanel}
        </View>
      )}

      <PaymentDialog visible={paying} total={total} onCancel={() => setPaying(false)} onConfirm={complete} />
      {ocr ? (
        <ReceiptScanDialog
          visible={scanning}
          products={products.filter((p) => p.active)}
          sets={Array.from(setsById.values()).filter((set) => set.active)}
          replacing={lines.length > 0}
          onCancel={() => setScanning(false)}
          onConfirm={applyScan}
        />
      ) : null}
      <ReceiptDialog sale={lastSale} onClose={finishReceipt} closeLabel="New sale" />
    </View>
  );
}

function ProductCard({
  product,
  level,
  inCart,
  onPress,
  row,
  width,
}: {
  product: Product;
  level: StockLevel;
  inCart: number;
  onPress: () => void;
  row: boolean;
  width: number;
}) {
  const { colors } = useTheme();
  const stock = sellable(product, level);
  const out = stock <= 0;
  const low = isLowStock(product, level);
  const stockLabel = out
    ? 'Out of stock'
    : product.kind === 'cylinder'
      ? `${level.full} full · ${level.empty} empty`
      : `${level.unit} in stock`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add ${product.name}. ${stockLabel}.`}
      disabled={out}
      onPress={onPress}
      style={({ pressed }) => [
        row ? styles.productRow : [styles.productCard, { width }],
        {
          backgroundColor: pressed ? colors.primarySoft : colors.surface,
          borderColor: inCart > 0 ? colors.primary : colors.border,
          opacity: out ? 0.5 : 1,
        },
      ]}
    >
      <View style={[styles.productIcon, { backgroundColor: product.kind === 'cylinder' ? colors.primarySoft : colors.surfaceMuted }]}>
        <Icon name={product.kind === 'cylinder' ? 'flame-outline' : 'construct-outline'} color={product.kind === 'cylinder' ? colors.primary : colors.textMuted} />
      </View>
      <View style={styles.productInfo}>
        <Text weight="700" numberOfLines={1}>
          {product.name}
        </Text>
        <Text variant="small" muted numeric>
          {product.kind === 'cylinder'
            ? `Refill ${formatPeso(product.refillPrice ?? product.price)} · New ${formatPeso(product.price)}`
            : formatPeso(product.price)}
        </Text>
        <View style={styles.productBadges}>
          <Badge label={stockLabel} tone={out ? 'danger' : low ? 'warning' : 'neutral'} />
          {inCart > 0 ? <Badge label={`${inCart} in cart`} tone="info" /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function SetCard({
  set,
  products,
  available,
  inCart,
  onPress,
  row,
  width,
}: {
  set: ProductSet;
  products: Map<string, Product>;
  available: boolean;
  inCart: number;
  onPress: () => void;
  row: boolean;
  width: number;
}) {
  const { colors } = useTheme();
  const regular = regularPrice(set, products);
  const saving = regular - set.price;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add ${set.name}, ${formatPeso(set.price)}.${available ? '' : ' Out of stock.'}`}
      disabled={!available}
      onPress={onPress}
      style={({ pressed }) => [
        row ? styles.productRow : [styles.productCard, { width }],
        {
          backgroundColor: pressed ? colors.primarySoft : colors.surface,
          borderColor: inCart > 0 ? colors.primary : colors.border,
          opacity: available ? 1 : 0.5,
        },
      ]}
    >
      <View style={[styles.productIcon, { backgroundColor: colors.primarySoft }]}>
        <Icon name="gift-outline" color={colors.primary} />
      </View>
      <View style={styles.productInfo}>
        <Text weight="700" numberOfLines={1}>
          {set.name}
        </Text>
        <Text variant="small" muted numberOfLines={2}>
          {describeSet(set, products)}
        </Text>
        <Text variant="small" numeric weight="600">
          {formatPeso(set.price)}
          {saving > 0 ? (
            <Text variant="small" muted numeric style={styles.strike}>
              {`  ${formatPeso(regular)}`}
            </Text>
          ) : null}
        </Text>
        <View style={styles.productBadges}>
          {!available ? <Badge label="Out of stock" tone="danger" /> : saving > 0 ? <Badge label={`Save ${formatPeso(saving)}`} tone="success" /> : null}
          {inCart > 0 ? <Badge label={`${inCart} in cart`} tone="info" /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function CartPanel({
  lines,
  priced,
  products,
  total,
  slipNo,
  onQty,
  onType,
  onClear,
  onCharge,
  compact,
}: {
  lines: CartLine[];
  priced: SaleLine[];
  products: Map<string, Product>;
  total: number;
  /** Shown when the cart was scanned from a handwritten receipt. */
  slipNo: string | null;
  onQty: (line: CartLine, qty: number) => void;
  onType: (line: CartLine, type: ProductLineType) => void;
  onClear: () => void;
  onCharge: () => void;
  compact: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Card
      title="Current sale"
      action={lines.length > 0 ? <Button title="Clear" variant="ghost" size="sm" onPress={onClear} shortcut="F4" /> : null}
      style={compact ? styles.cartCompact : styles.cartWide}
    >
      {slipNo ? <Badge label={`From receipt no. ${slipNo}`} tone="info" icon="receipt-outline" /> : null}
      <ScrollView style={compact ? styles.cartLinesCompact : styles.cartLines} contentContainerStyle={styles.cartLinesContent}>
        {lines.length === 0 ? (
          <EmptyState icon="cart-outline" title="No items yet" message="Tap a product or a set to add it." />
        ) : (
          lines.map((line, i) => {
            const sale = priced[i];
            if (!sale) return null;
            const product = line.type === 'set' ? undefined : products.get(line.productId);
            return (
              <View key={cartLineKey(line)} style={[styles.cartLine, { borderBottomColor: colors.border }]}>
                <View style={styles.cartLineTop}>
                  <Text weight="600" style={styles.flex} numberOfLines={1}>
                    {sale.name}
                  </Text>
                  <Text weight="600" numeric>
                    {formatPeso(sale.amount)}
                  </Text>
                </View>
                {sale.type === 'set' ? (
                  <Text variant="small" muted>
                    {sale.items.map((item) => `${item.qty} × ${item.name}${item.type === 'item' ? '' : ` (${item.type})`}`).join(', ')}
                  </Text>
                ) : null}
                {sale.type === 'new' && sale.contentPrice !== undefined ? (
                  <Text variant="small" muted numeric>
                    Cylinder {formatPeso(sale.unitPrice - sale.contentPrice)} + content {formatPeso(sale.contentPrice)} each
                  </Text>
                ) : null}
                <View style={styles.cartLineControls}>
                  {product?.kind === 'cylinder' ? (
                    <SegmentedControl
                      size="sm"
                      accessibilityLabel={`${product.name} sale type`}
                      options={[
                        { label: 'Refill', value: 'refill' },
                        { label: 'New', value: 'new' },
                      ]}
                      value={line.type === 'new' ? 'new' : 'refill'}
                      onChange={(type) => onType(line, type)}
                    />
                  ) : sale.type === 'set' ? (
                    <Badge label={`Set · ${formatPeso(sale.unitPrice)} each`} tone="info" icon="gift-outline" />
                  ) : (
                    <Text variant="small" muted>
                      {formatPeso(sale.unitPrice)} each
                    </Text>
                  )}
                  <View style={styles.flex} />
                  <Stepper value={line.qty} onChange={(qty) => onQty(line, qty)} label={sale.name} />
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
      <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
        <Text variant="subheading">Total</Text>
        <Text variant="heading" numeric>
          {formatPeso(total)}
        </Text>
      </View>
      <Button title="Charge" icon="cash-outline" size="lg" onPress={onCharge} disabled={lines.length === 0} shortcut="F9" fullWidth />
    </Card>
  );
}

function Stepper({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  const { colors } = useTheme();
  const step = (icon: 'remove' | 'add', next: number, a11y: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={() => onChange(next)}
      style={[styles.stepButton, { borderColor: colors.border, backgroundColor: colors.surface }]}
    >
      <Icon name={icon} size={16} />
    </Pressable>
  );
  return (
    <View style={styles.stepper}>
      {step('remove', value - 1, `One less ${label}`)}
      <Text weight="700" numeric style={styles.stepValue}>
        {value}
      </Text>
      {step('add', value + 1, `One more ${label}`)}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: spacing.xl, gap: spacing.lg },
  wide: { flex: 1, flexDirection: 'row', gap: spacing.lg, minHeight: 0 },
  narrow: { flex: 1, gap: spacing.md, minHeight: 0 },
  catalog: { flex: 1, gap: spacing.md, minHeight: 0 },
  cartColumn: { width: 400 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  search: { flexGrow: 1, flexBasis: 220 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingBottom: spacing.lg },
  list: { flexDirection: 'column', flexWrap: 'nowrap' },
  productCard: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    cursor: 'pointer',
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  productIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  productInfo: { flex: 1, gap: 4 },
  productBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  cartWide: { flex: 1 },
  cartCompact: { maxHeight: '55%' },
  cartLines: { flex: 1 },
  cartLinesCompact: { maxHeight: 220 },
  cartLinesContent: { flexGrow: 1 },
  cartLine: { paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.sm },
  cartLineTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cartLineControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, paddingTop: spacing.md },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepButton: { width: 32, height: 32, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  stepValue: { minWidth: 24, textAlign: 'center' },
  strike: { textDecorationLine: 'line-through', fontWeight: '400' },
  flex: { flex: 1 },
});

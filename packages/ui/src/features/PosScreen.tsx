import {
  addToCart,
  ALLOW_NEGATIVE_STOCK,
  cartDemand,
  changeQty,
  changeType,
  formatPeso,
  isLowStock,
  levelOf,
  priceCart,
  recordSale,
  sellable,
  stockByProduct,
  type CartLine,
  type Payment,
  type Product,
  type ProductKind,
  type Sale,
  type SaleLine,
  type StockLevel,
  type StockMovement,
} from '@sgm/core';
import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Badge, Card, EmptyState, ScreenHeader, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useToast } from '../Toast';
import { useBreakpoint } from '../useBreakpoint';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { PaymentDialog } from './PaymentDialog';
import { ReceiptDialog } from './receipts';

const KIND_OPTIONS: { label: string; value: 'all' | ProductKind }[] = [
  { label: 'All', value: 'all' },
  { label: 'Cylinders', value: 'cylinder' },
  { label: 'Accessories', value: 'accessory' },
];

const sameLine = (a: CartLine, b: CartLine) => a.productId === b.productId && a.type === b.type;

/** Product cards fill the row: as many columns as fit at this width or wider. */
const MIN_CARD_WIDTH = 200;

/** The counter screen: pick products, choose refill or new cylinder, take payment, print. */
export function PosScreen() {
  const work = useWork();
  const toast = useToast();
  const { isWide } = useBreakpoint();
  const { data: products } = useCollection<Product>('products');
  const { data: movements } = useCollection<StockMovement>('movements');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | ProductKind>('all');
  const [paying, setPaying] = useState(false);
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const searchRef = useRef<TextInput>(null);

  const columns = Math.max(1, Math.floor((gridWidth + spacing.md) / (MIN_CARD_WIDTH + spacing.md)));
  const cardWidth = gridWidth > 0 ? Math.floor((gridWidth - spacing.md * (columns - 1)) / columns) : MIN_CARD_WIDTH;

  const byId = new Map(products.map((p) => [p.id, p]));
  const levels = stockByProduct(movements, work.locationId);
  const lines = cart.filter((line) => byId.has(line.productId));
  const { lines: priced, total } = priceCart(lines, byId);
  const demand = cartDemand(lines);
  const q = query.trim().toLowerCase();
  const shown = products.filter(
    (p) => p.active && (kind === 'all' || p.kind === kind) && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)),
  );

  const roomFor = (product: Product, extra: number) =>
    ALLOW_NEGATIVE_STOCK || (demand.get(product.id) ?? 0) + extra <= sellable(product, levelOf(levels, product.id));

  const add = (product: Product) => {
    if (!roomFor(product, 1)) {
      toast.show(`No more ${product.name} in stock at ${work.location?.name ?? 'this branch'}.`, 'error');
      return;
    }
    setCart((current) => addToCart(current, product));
  };

  const setQty = (line: CartLine, qty: number) => {
    const product = byId.get(line.productId);
    if (product && qty > line.qty && !roomFor(product, qty - line.qty)) {
      toast.show(`No more ${product.name} in stock.`, 'error');
      return;
    }
    setCart((current) => changeQty(current, current.findIndex((l) => sameLine(l, line)), qty));
  };

  const setType = (line: CartLine, type: CartLine['type']) =>
    setCart((current) => changeType(current, current.findIndex((l) => sameLine(l, line)), type));

  const charge = () => {
    if (lines.length > 0) setPaying(true);
  };

  const complete = async (payment: Payment) => {
    const sale = await recordSale(work.ctx, { cart: lines, payment });
    setCart([]);
    setPaying(false);
    setLastSale(sale);
  };

  const finishReceipt = () => {
    setLastSale(null);
    searchRef.current?.focus();
  };

  useKeyboardShortcuts(
    {
      F2: () => searchRef.current?.focus(),
      F4: () => setCart([]),
      F9: charge,
    },
    !paying && !lastSale,
  );

  const catalog = (
    <View style={styles.catalog}>
      <View style={styles.toolbar}>
        <TextField
          ref={searchRef}
          placeholder={Platform.OS === 'web' ? 'Search products (F2)' : 'Search products'}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => {
            if (shown.length === 1) add(shown[0]);
          }}
          containerStyle={styles.search}
          accessibilityLabel="Search products"
        />
        <SegmentedControl options={KIND_OPTIONS} value={kind} onChange={setKind} accessibilityLabel="Product type" />
      </View>
      <ScrollView
        onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}
        contentContainerStyle={[styles.grid, !isWide && styles.list]}
      >
        {shown.map((product) => (
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
        {shown.length === 0 ? <EmptyState icon="search-outline" title="No products match" message="Try another name or type." /> : null}
      </ScrollView>
    </View>
  );

  const cartPanel = (
    <CartPanel
      lines={lines}
      priced={priced}
      products={byId}
      total={total}
      onQty={setQty}
      onType={setType}
      onClear={() => setCart([])}
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
          Platform.OS === 'web' ? (
            <Text variant="small" muted>
              F2 search · F4 clear · F9 charge
            </Text>
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

function CartPanel({
  lines,
  priced,
  products,
  total,
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
  onQty: (line: CartLine, qty: number) => void;
  onType: (line: CartLine, type: CartLine['type']) => void;
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
      <ScrollView style={compact ? styles.cartLinesCompact : styles.cartLines} contentContainerStyle={styles.cartLinesContent}>
        {lines.length === 0 ? (
          <EmptyState icon="cart-outline" title="No items yet" message="Tap a product to add it." />
        ) : (
          lines.map((line, i) => {
            const product = products.get(line.productId);
            const sale = priced[i];
            if (!product || !sale) return null;
            return (
              <View key={`${line.productId}-${line.type}`} style={[styles.cartLine, { borderBottomColor: colors.border }]}>
                <View style={styles.cartLineTop}>
                  <Text weight="600" style={styles.flex} numberOfLines={1}>
                    {product.name}
                  </Text>
                  <Text weight="600" numeric>
                    {formatPeso(sale.amount)}
                  </Text>
                </View>
                <View style={styles.cartLineControls}>
                  {product.kind === 'cylinder' ? (
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
                  ) : (
                    <Text variant="small" muted>
                      {formatPeso(sale.unitPrice)} each
                    </Text>
                  )}
                  <View style={styles.flex} />
                  <Stepper value={line.qty} onChange={(qty) => onQty(line, qty)} label={product.name} />
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
  flex: { flex: 1 },
});

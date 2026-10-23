import {
  addDays,
  formatDateTime,
  formatDay,
  isLowStock,
  levelOf,
  localDay,
  MOVEMENT_LABELS,
  movementRows,
  parseDay,
  sellable,
  stockBefore,
  stockByProduct,
  type LevelChange,
  type MovementRow,
  type Product,
  type StockLevel,
  type StockMovement,
  type User,
} from '@sgm/core';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Card, ScreenHeader } from '../Basics';
import { Button } from '../Button';
import { DataTable, SplitCell, type Column } from '../DataTable';
import { DateField } from '../DateField';
import { Icon } from '../Icon';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { spacing, useTheme } from '../theme';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { MovementDialog, type MovementStart } from './MovementDialog';
import { TransfersCard } from './TransfersCard';

interface StockRow {
  product: Product;
  /** At midnight, when the day started. */
  start: StockLevel;
  /** Now, or at the end of a past day. */
  end: StockLevel;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const units = (n: number) => (Math.abs(n) === 1 ? 'unit' : 'units');

/** "40 full · 15 empty" for cylinders, "15 units" for accessories, and "· 2 defective" when there are any. */
function levelText(product: Product, level: StockLevel): string {
  const good = product.kind === 'cylinder' ? `${level.full} full · ${level.empty} empty` : `${level.unit} ${units(level.unit)}`;
  return level.defective !== 0 ? `${good} · ${level.defective} defective` : good;
}

function changeText(product: Product, start: StockLevel, end: StockLevel): string {
  const diff = end.unit - start.unit;
  if (product.kind !== 'cylinder') return diff === 0 ? 'No change' : `${signed(diff)} ${units(diff)}`;
  const parts = [
    end.full !== start.full ? `${signed(end.full - start.full)} full` : '',
    end.empty !== start.empty ? `${signed(end.empty - start.empty)} empty` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No change';
}

/** "-1 full" and "+1 empty" for a cylinder, "-2" for an accessory, with a defective line when it changed. */
function changeParts(product: Product | undefined, change: StockLevel): { line: string; amount: number }[] {
  const good =
    product?.kind === 'cylinder'
      ? [
          { line: `${signed(change.full)} full`, amount: change.full },
          { line: `${signed(change.empty)} empty`, amount: change.empty },
        ]
      : [{ line: change.defective !== 0 ? `${signed(change.unit)} in stock` : signed(change.unit), amount: change.unit }];
  return change.defective !== 0 ? [...good, { line: `${signed(change.defective)} defective`, amount: change.defective }] : good;
}

const changeLines = (product: Product | undefined, change: StockLevel) => changeParts(product, change).map((p) => p.line);

/** One line per condition, lined up with Before → after; a line with no change is greyed out. */
function ChangeLines({ product, change }: { product: Product | undefined; change: StockLevel }) {
  return (
    <View>
      {changeParts(product, change).map(({ line, amount }) => (
        <Text key={line} variant="small" numeric muted={amount === 0}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** One line per condition: the cylinder's full and empty count before and after, or an accessory's units. */
function BeforeAfter({ product, change }: { product: Product | undefined; change: LevelChange }) {
  const { before, after } = change;
  const row = (label: string, from: number, to: number) => (
    <Text key={label} variant="small" numeric muted={from === to} weight={from === to ? '400' : '600'}>
      {label ? `${label} ` : ''}
      {from} → {to}
    </Text>
  );
  const defective = before.defective !== after.defective;
  if (product?.kind !== 'cylinder' && !defective) return row('', before.unit, after.unit);
  return (
    <View>
      {product?.kind === 'cylinder' ? (
        <>
          {row('Full', before.full, after.full)}
          {row('Empty', before.empty, after.empty)}
        </>
      ) : (
        row('In stock', before.unit, after.unit)
      )}
      {defective ? row('Defective', before.defective, after.defective) : null}
    </View>
  );
}

const FULL_EMPTY = ['Full', 'Empty'];

/** Full and empty apart for a cylinder; one count across both for an accessory. */
function LevelCell({ product, level }: { product: Product; level: StockLevel }) {
  return product.kind === 'cylinder' ? (
    <SplitCell values={[String(level.full), String(level.empty)]} />
  ) : (
    <SplitCell values={[`${level.unit} ${units(level.unit)}`]} />
  );
}

function ChangeCell({ product, start, end }: { product: Product; start: StockLevel; end: StockLevel }) {
  if (product.kind !== 'cylinder') {
    const diff = end.unit - start.unit;
    return <SplitCell values={[diff === 0 ? '0' : `${signed(diff)} ${units(diff)}`]} muted={[diff === 0]} />;
  }
  const full = end.full - start.full;
  const empty = end.empty - start.empty;
  return <SplitCell values={[signed(full), signed(empty)]} muted={[full === 0, empty === 0]} />;
}

const stockColumns = (endTitle: string): Column<StockRow>[] => [
  { key: 'name', title: 'Product', flex: 2, text: (r) => r.product.name },
  {
    key: 'start',
    title: 'Beg. Stock',
    width: 150,
    subColumns: FULL_EMPTY,
    text: (r) => levelText(r.product, r.start),
    sortValue: (r) => sellable(r.product, r.start),
    render: (r) => <LevelCell product={r.product} level={r.start} />,
  },
  {
    key: 'change',
    title: 'Change',
    width: 150,
    subColumns: FULL_EMPTY,
    text: (r) => changeText(r.product, r.start, r.end),
    sortValue: (r) => sellable(r.product, r.end) - sellable(r.product, r.start),
    render: (r) => <ChangeCell product={r.product} start={r.start} end={r.end} />,
  },
  {
    key: 'end',
    title: endTitle,
    width: 150,
    subColumns: FULL_EMPTY,
    text: (r) => levelText(r.product, r.end),
    sortValue: (r) => sellable(r.product, r.end),
    render: (r) => <LevelCell product={r.product} level={r.end} />,
  },
  {
    key: 'defective',
    title: 'Defective',
    width: 90,
    align: 'center',
    text: (r) => String(r.end.defective),
    sortValue: (r) => r.end.defective,
    render: (r) => (
      <Text numeric muted={r.end.defective === 0}>
        {r.end.defective}
      </Text>
    ),
  },
  {
    key: 'status',
    title: 'Status',
    width: 110,
    sortValue: (r) => (isLowStock(r.product, r.end) ? 0 : 1),
    render: (r) =>
      sellable(r.product, r.end) <= 0 ? (
        <Badge label="Out of stock" tone="danger" />
      ) : isLowStock(r.product, r.end) ? (
        <Badge label="Low" tone="warning" icon="warning-outline" />
      ) : (
        <Badge label="OK" tone="success" />
      ),
  },
  { key: 'kind', title: 'Type', width: 100, text: (r) => (r.product.kind === 'cylinder' ? 'Cylinder' : 'Accessory') },
];

export function InventoryScreen({
  adjustProductId,
  onAdjustDone,
}: {
  /** Opens a stock adjustment of this product, as when a low-stock item is clicked on the dashboard. */
  adjustProductId?: string;
  /** Called when that adjustment closes, so the app can forget it (and open it again on the next click). */
  onAdjustDone?: () => void;
} = {}) {
  const work = useWork();
  const { colors } = useTheme();
  const { data: products } = useCollection<Product>('products');
  const { data: movements } = useCollection<StockMovement>('movements');
  const { data: users } = useCollection<User>('users');
  const [recording, setRecording] = useState(false);
  const [start, setStart] = useState<MovementStart | undefined>(undefined);
  const today = localDay(new Date());
  const [day, setDay] = useState(today);
  const canRecord = work.can('inventory.record');

  useEffect(() => {
    if (adjustProductId && canRecord) {
      // Low or out of stock is usually fixed with stock from the depot.
      setStart({ type: 'DELIVERY_IN', productId: adjustProductId });
      setRecording(true);
    }
  }, [adjustProductId, canRecord]);

  const closeRecording = () => {
    setRecording(false);
    if (start) {
      setStart(undefined);
      onAdjustDone?.();
    }
  };

  useKeyboardShortcuts({ 'Ctrl+N': () => canRecord && setRecording(true) }, !recording);

  const isToday = day >= today;
  const dayStart = parseDay(day).toISOString();
  const startLevels = stockBefore(movements, work.locationId, dayStart);
  const endLevels = isToday
    ? stockByProduct(movements, work.locationId)
    : stockBefore(movements, work.locationId, parseDay(addDays(day, 1)).toISOString());
  const rows: StockRow[] = products
    .filter((p) => p.active)
    .map((product) => ({ product, start: levelOf(startLevels, product.id), end: levelOf(endLevels, product.id) }));

  const productsById = new Map(products.map((p) => [p.id, p]));
  const productName = (id: string) => productsById.get(id)?.name ?? id;
  const userName = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;
  const placeName = (id: string) => work.locations.find((l) => l.id === id)?.name ?? id;
  // Stock sent between branches names the other one.
  const whatText = (r: MovementRow) => {
    const other = r.movements[0]?.counterpartLocationId;
    if (!other) return MOVEMENT_LABELS[r.type];
    if (r.type === 'TRANSFER_IN') return `Stocks In from ${placeName(other)}`;
    if (r.type === 'TRANSFER_OUT') return `Stocks Out to ${placeName(other)}`;
    if (r.type === 'TRANSFER_FIX') return `Stocks Out to ${placeName(other)}, settled`;
    return MOVEMENT_LABELS[r.type];
  };
  // Newest first. A sale's full cylinder going out and its empty coming in are one row.
  const history = movementRows(movements, work.locationId).reverse();

  const movementColumns: Column<MovementRow>[] = [
    { key: 'when', title: 'When', width: 190, text: (r) => formatDateTime(r.occurredAt), sortValue: (r) => r.occurredAt },
    { key: 'type', title: 'What', flex: 1.3, text: whatText },
    { key: 'product', title: 'Product', flex: 1.3, text: (r) => productName(r.productId) },
    {
      key: 'change',
      title: 'Change',
      width: 95,
      text: (r) => changeLines(productsById.get(r.productId), r.change).join(' '),
      sortValue: (r) => {
        const product = productsById.get(r.productId);
        return product ? sellable(product, r.change) : r.change.full + r.change.unit;
      },
      render: (r) => <ChangeLines product={productsById.get(r.productId)} change={r.change} />,
    },
    {
      key: 'beforeAfter',
      title: 'Before → after',
      width: 125,
      render: (r) => <BeforeAfter product={productsById.get(r.productId)} change={r} />,
    },
    { key: 'by', title: 'By', flex: 1, text: (r) => userName(r.userId) },
    { key: 'reason', title: 'Reason', flex: 1.2, text: (r) => r.reason ?? '' },
    {
      key: 'synced',
      title: 'Synced',
      width: 70,
      align: 'center',
      sortValue: (r) => (r.synced ? 1 : 0),
      render: (r) => (
        <Icon name={r.synced ? 'cloud-done-outline' : 'cloud-upload-outline'} color={r.synced ? colors.success : colors.warning} />
      ),
    },
  ];

  const lowCount = rows.filter((r) => isLowStock(r.product, r.end)).length;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Inventory"
        subtitle={`${work.location?.name ?? ''} · ${lowCount} item${lowCount === 1 ? '' : 's'} low on stock`}
        actions={
          canRecord ? <Button title="Record movement" icon="add" onPress={() => setRecording(true)} shortcut="Ctrl+N" /> : null
        }
      />
      <TransfersCard />
      <Card
        title={isToday ? 'Stock today' : `Stock on ${formatDay(day)}`}
        action={
          <View style={styles.dayField}>
            <DateField value={day} onChange={setDay} max={today} />
          </View>
        }
        padded
      >
        <View style={styles.note}>
          <Text variant="small" muted>
            {isToday
              ? 'Beg. Stock is the stock at the start of the day (midnight); Now includes every sale and movement since. Defective items are counted apart and are never sold.'
              : 'Beg. Stock is the stock at the start of the day (midnight); End of day is the stock at the following midnight. Defective items are counted apart and are never sold.'}
          </Text>
        </View>
        <DataTable
          rows={rows}
          columns={stockColumns(isToday ? 'Now' : 'End of day')}
          rowKey={(r) => r.product.id}
          searchPlaceholder="Search stock"
          initialSort={{ key: 'name', direction: 'asc' }}
          minWidth={910}
        />
      </Card>
      <Card title="Movement history" padded>
        <View style={styles.note}>
          <Text variant="small" muted>
            Every change to stock, newest first. A sale is one row per product, with its full and empty cylinders together. Before → after shows that product's stock just before and just after it.
          </Text>
        </View>
        <DataTable rows={history} columns={movementColumns} rowKey={(r) => r.id} pageSize={10} minWidth={1040} searchPlaceholder="Search movements" />
      </Card>
      <MovementDialog visible={recording} onClose={closeRecording} start={start} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  note: { marginTop: -spacing.sm },
  dayField: { width: 190 },
});

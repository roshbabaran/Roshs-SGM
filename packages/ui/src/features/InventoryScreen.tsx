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
import { useState } from 'react';
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
import { MovementDialog } from './MovementDialog';

interface StockRow {
  product: Product;
  /** At midnight, when the day started. */
  start: StockLevel;
  /** Now, or at the end of a past day. */
  end: StockLevel;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const units = (n: number) => (Math.abs(n) === 1 ? 'unit' : 'units');

/** "40 full · 15 empty" for cylinders, "15 units" for accessories. */
function levelText(product: Product, level: StockLevel): string {
  return product.kind === 'cylinder' ? `${level.full} full · ${level.empty} empty` : `${level.unit} ${units(level.unit)}`;
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

/** "-1 full" and "+1 empty" for a cylinder, "-2" for an accessory. */
function changeLines(product: Product | undefined, change: StockLevel): string[] {
  return product?.kind === 'cylinder'
    ? [`${signed(change.full)} full`, `${signed(change.empty)} empty`]
    : [signed(change.unit)];
}

/** One line per condition, lined up with Before → after; a line with no change is greyed out. */
function ChangeLines({ product, change }: { product: Product | undefined; change: StockLevel }) {
  const amounts = product?.kind === 'cylinder' ? [change.full, change.empty] : [change.unit];
  return (
    <View>
      {changeLines(product, change).map((line, i) => (
        <Text key={line} variant="small" numeric muted={amounts[i] === 0} numberOfLines={1}>
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
    <Text key={label} variant="small" numeric muted={from === to} weight={from === to ? '400' : '600'} numberOfLines={1}>
      {label ? `${label} ` : ''}
      {from} → {to}
    </Text>
  );
  if (product?.kind !== 'cylinder') return row('', before.unit, after.unit);
  return (
    <View>
      {row('Full', before.full, after.full)}
      {row('Empty', before.empty, after.empty)}
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
    key: 'end',
    title: endTitle,
    width: 150,
    subColumns: FULL_EMPTY,
    text: (r) => levelText(r.product, r.end),
    sortValue: (r) => sellable(r.product, r.end),
    render: (r) => <LevelCell product={r.product} level={r.end} />,
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

export function InventoryScreen() {
  const work = useWork();
  const { colors } = useTheme();
  const { data: products } = useCollection<Product>('products');
  const { data: movements } = useCollection<StockMovement>('movements');
  const { data: users } = useCollection<User>('users');
  const [recording, setRecording] = useState(false);
  const today = localDay(new Date());
  const [day, setDay] = useState(today);
  const canRecord = work.can('inventory.record');

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
  // Newest first. A sale's full cylinder going out and its empty coming in are one row.
  const history = movementRows(movements, work.locationId).reverse();

  const movementColumns: Column<MovementRow>[] = [
    { key: 'when', title: 'When', width: 190, text: (r) => formatDateTime(r.occurredAt), sortValue: (r) => r.occurredAt },
    { key: 'type', title: 'What', flex: 1.3, text: (r) => MOVEMENT_LABELS[r.type] },
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
              ? 'Beg. Stock is the stock at the start of the day (midnight); Now includes every sale and movement since.'
              : 'Beg. Stock is the stock at the start of the day (midnight); End of day is the stock at the following midnight.'}
          </Text>
        </View>
        <DataTable
          rows={rows}
          columns={stockColumns(isToday ? 'Now' : 'End of day')}
          rowKey={(r) => r.product.id}
          searchPlaceholder="Search stock"
          initialSort={{ key: 'name', direction: 'asc' }}
          minWidth={820}
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
      <MovementDialog visible={recording} onClose={() => setRecording(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  note: { marginTop: -spacing.sm },
  dayField: { width: 190 },
});

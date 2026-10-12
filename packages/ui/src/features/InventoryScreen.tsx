import {
  formatDateTime,
  isLowStock,
  levelOf,
  MOVEMENT_LABELS,
  sellable,
  stockByProduct,
  type Product,
  type StockLevel,
  type StockMovement,
  type User,
} from '@sgm/core';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Card, ScreenHeader } from '../Basics';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { Icon } from '../Icon';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { spacing, useTheme } from '../theme';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { MovementDialog } from './MovementDialog';

interface StockRow {
  product: Product;
  level: StockLevel;
}

const stockColumns: Column<StockRow>[] = [
  { key: 'name', title: 'Product', flex: 2, text: (r) => r.product.name },
  { key: 'sku', title: 'Code', flex: 1, text: (r) => r.product.sku },
  { key: 'kind', title: 'Type', flex: 1, text: (r) => (r.product.kind === 'cylinder' ? 'Cylinder' : 'Accessory') },
  {
    key: 'full',
    title: 'Full / units',
    width: 120,
    align: 'right',
    text: (r) => String(sellable(r.product, r.level)),
    sortValue: (r) => sellable(r.product, r.level),
  },
  {
    key: 'empty',
    title: 'Empty',
    width: 100,
    align: 'right',
    text: (r) => (r.product.kind === 'cylinder' ? String(r.level.empty) : '—'),
    sortValue: (r) => r.level.empty,
  },
  {
    key: 'status',
    title: 'Status',
    width: 130,
    sortValue: (r) => (isLowStock(r.product, r.level) ? 0 : 1),
    render: (r) =>
      sellable(r.product, r.level) <= 0 ? (
        <Badge label="Out of stock" tone="danger" />
      ) : isLowStock(r.product, r.level) ? (
        <Badge label="Low" tone="warning" icon="warning-outline" />
      ) : (
        <Badge label="OK" tone="success" />
      ),
  },
];

export function InventoryScreen() {
  const work = useWork();
  const { colors } = useTheme();
  const { data: products } = useCollection<Product>('products');
  const { data: movements } = useCollection<StockMovement>('movements');
  const { data: users } = useCollection<User>('users');
  const [recording, setRecording] = useState(false);
  const canRecord = work.can('inventory.record');

  useKeyboardShortcuts({ 'Ctrl+N': () => canRecord && setRecording(true) }, !recording);

  const levels = stockByProduct(movements, work.locationId);
  const rows: StockRow[] = products.filter((p) => p.active).map((product) => ({ product, level: levelOf(levels, product.id) }));
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const userName = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;
  const recent = movements
    .filter((m) => m.locationId === work.locationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const movementColumns: Column<StockMovement>[] = [
    { key: 'when', title: 'When', width: 190, text: (m) => formatDateTime(m.occurredAt), sortValue: (m) => m.occurredAt },
    { key: 'type', title: 'What', flex: 1.4, text: (m) => MOVEMENT_LABELS[m.type] },
    { key: 'product', title: 'Product', flex: 1.4, text: (m) => productName(m.productId) },
    {
      key: 'qty',
      title: 'Change',
      width: 130,
      align: 'right',
      text: (m) => `${m.qty > 0 ? '+' : ''}${m.qty} ${m.condition === 'unit' ? '' : m.condition}`.trim(),
      sortValue: (m) => m.qty,
    },
    { key: 'by', title: 'By', flex: 1, text: (m) => userName(m.userId) },
    { key: 'reason', title: 'Reason', flex: 1.2, text: (m) => m.reason ?? '' },
    {
      key: 'synced',
      title: 'Synced',
      width: 80,
      align: 'center',
      sortValue: (m) => (m.receivedAt ? 1 : 0),
      render: (m) => (
        <Icon
          name={m.receivedAt ? 'cloud-done-outline' : 'cloud-upload-outline'}
          color={m.receivedAt ? colors.success : colors.warning}
        />
      ),
    },
  ];

  const lowCount = rows.filter((r) => isLowStock(r.product, r.level)).length;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Inventory"
        subtitle={`${work.location?.name ?? ''} · ${lowCount} item${lowCount === 1 ? '' : 's'} low on stock`}
        actions={
          canRecord ? <Button title="Record movement" icon="add" onPress={() => setRecording(true)} shortcut="Ctrl+N" /> : null
        }
      />
      <Card title="Stock on hand" padded>
        <DataTable
          rows={rows}
          columns={stockColumns}
          rowKey={(r) => r.product.id}
          searchPlaceholder="Search stock"
          initialSort={{ key: 'name', direction: 'asc' }}
        />
      </Card>
      <Card title="Recent movements" padded>
        <View style={styles.note}>
          <Text variant="small" muted>
            Every change to stock is a movement. Stock on hand is the sum of all movements, so two devices can work offline and sync later without overwriting each other.
          </Text>
        </View>
        <DataTable rows={recent} columns={movementColumns} rowKey={(m) => m.id} pageSize={10} minWidth={900} searchPlaceholder="Search movements" />
      </Card>
      <MovementDialog visible={recording} onClose={() => setRecording(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  note: { marginTop: -spacing.sm },
});

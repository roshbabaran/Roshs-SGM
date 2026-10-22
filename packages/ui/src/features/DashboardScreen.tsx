import {
  addDays,
  dailyTotals,
  dayRange,
  formatPeso,
  formatTime,
  isLowStock,
  levelOf,
  localDay,
  salesBetween,
  sellable,
  stockByProduct,
  type Product,
  type Sale,
  type StockMovement,
} from '@sgm/core';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Card, EmptyState, ScreenHeader, StatTile } from '../Basics';
import { BarChart } from '../BarChart';
import { useCollection, useSyncStatus, useWork } from '../services';
import { Text } from '../Text';
import { spacing, useTheme } from '../theme';

/** Shortens peso amounts for chart labels: ₱12.5k */
export function shortPeso(centavos: number): string {
  const pesos = centavos / 100;
  if (pesos >= 1_000_000) return `₱${(pesos / 1_000_000).toFixed(1)}M`;
  if (pesos >= 1_000) return `₱${(pesos / 1_000).toFixed(pesos >= 10_000 ? 0 : 1)}k`;
  return `₱${Math.round(pesos)}`;
}

export function DashboardScreen() {
  const work = useWork();
  const sync = useSyncStatus();
  const { colors } = useTheme();
  const { data: sales } = useCollection<Sale>('sales');
  const { data: products } = useCollection<Product>('products');
  const { data: movements } = useCollection<StockMovement>('movements');

  const today = localDay(new Date());
  const weekStart = addDays(today, -6);
  const todaySales = salesBetween(sales, today, today, work.locationId);
  const weekSales = salesBetween(sales, weekStart, today, work.locationId);
  const todayTotal = todaySales.reduce((sum, s) => sum + s.total, 0);
  const levels = stockByProduct(movements, work.locationId);
  const low = products.filter((p) => p.active && isLowStock(p, levelOf(levels, p.id)));
  const chart = dailyTotals(weekSales, dayRange(weekStart, today)).map((d) => ({ label: d.label, value: d.total }));
  const recent = [...todaySales].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader title={`Good day, ${work.user?.displayName ?? ''}`} subtitle={work.location?.name ?? undefined} />
      <View style={styles.tiles}>
        <StatTile label="Sales today" value={formatPeso(todayTotal)} hint={`${todaySales.length} transactions`} icon="cash-outline" />
        <StatTile label="This week" value={formatPeso(weekSales.reduce((s, x) => s + x.total, 0))} hint={`${weekSales.length} transactions`} icon="calendar-outline" />
        <StatTile
          label="Low on stock"
          value={String(low.length)}
          hint={low.length > 0 ? 'Needs stock from the depot or another branch' : 'All items above minimum'}
          icon="cube-outline"
          tone={low.length > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Waiting to sync"
          value={String(sync.pending)}
          hint={sync.state === 'offline' ? 'Offline: will send when connected' : sync.pending === 0 ? 'Everything is on the server' : 'Sending soon'}
          icon="cloud-upload-outline"
          tone={sync.state === 'offline' ? 'warning' : 'neutral'}
        />
      </View>

      <View style={styles.columns}>
        <Card title="Sales, last 7 days" style={styles.chartCard}>
          <BarChart data={chart} formatValue={formatPeso} formatAxis={shortPeso} />
        </Card>
        <Card title="Low stock" style={styles.sideCard}>
          {low.length === 0 ? (
            <EmptyState icon="checkmark-circle-outline" title="Nothing is low" />
          ) : (
            low.map((p) => (
              <View key={p.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <Text style={styles.flex} numberOfLines={1}>
                  {p.name}
                </Text>
                <Badge label={`${sellable(p, levelOf(levels, p.id))} left`} tone="warning" />
              </View>
            ))
          )}
        </Card>
      </View>

      <Card title="Today's sales">
        {recent.length === 0 ? (
          <EmptyState icon="receipt-outline" title="No sales yet today" />
        ) : (
          recent.map((sale) => (
            <View key={sale.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
              <Text muted style={styles.time}>
                {formatTime(sale.createdAt)}
              </Text>
              <Text style={styles.flex} numberOfLines={1}>
                {sale.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}
              </Text>
              <Text weight="600" numeric>
                {formatPeso(sale.total)}
              </Text>
            </View>
          ))
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  chartCard: { flexGrow: 2, flexShrink: 1, flexBasis: 480 },
  sideCard: { flexGrow: 1, flexBasis: 280 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  time: { width: 72 },
  flex: { flex: 1 },
});

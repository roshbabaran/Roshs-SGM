import {
  addDays,
  dailyTotals,
  dayRange,
  formatPeso,
  localDay,
  paymentTotals,
  productTotals,
  salesBetween,
  type PaymentTotal,
  type ProductTotal,
  type Sale,
} from '@sgm/core';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Card, ScreenHeader, StatTile } from '../Basics';
import { BarChart } from '../BarChart';
import { DataTable, type Column } from '../DataTable';
import { DateField } from '../DateField';
import { Select } from '../Select';
import { useCollection, useWork } from '../services';
import { spacing } from '../theme';
import { shortPeso } from './DashboardScreen';

const productColumns: Column<ProductTotal>[] = [
  { key: 'name', title: 'Product', flex: 2, text: (p) => p.name },
  { key: 'qty', title: 'Qty sold', width: 110, align: 'right', text: (p) => String(p.qty), sortValue: (p) => p.qty },
  { key: 'amount', title: 'Amount', width: 140, align: 'right', text: (p) => formatPeso(p.amount), sortValue: (p) => p.amount },
];

const paymentColumns: Column<PaymentTotal>[] = [
  { key: 'method', title: 'Payment', flex: 1, text: (p) => p.label },
  { key: 'count', title: 'Sales', width: 90, align: 'right', text: (p) => String(p.count), sortValue: (p) => p.count },
  { key: 'amount', title: 'Amount', width: 140, align: 'right', text: (p) => formatPeso(p.amount), sortValue: (p) => p.amount },
];

const ALL = 'all';

export function ReportsScreen() {
  const work = useWork();
  const { data: sales } = useCollection<Sale>('sales');
  const today = localDay(new Date());
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [locationId, setLocationId] = useState<string>(ALL);

  // Long ranges would crowd the chart, so it shows at most the last 31 days of the range.
  const chartFrom = from < addDays(to, -30) ? addDays(to, -30) : from;
  const inRange = salesBetween(sales, from, to, locationId === ALL ? undefined : locationId);
  const total = inRange.reduce((sum, s) => sum + s.total, 0);
  const chart = dailyTotals(inRange, dayRange(chartFrom, to)).map((d) => ({ label: d.label, value: d.total }));

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader title="Reports" subtitle="Completed sales only; voided sales are left out." />
      <Card padded>
        <View style={styles.filters}>
          <View style={styles.field}>
            <DateField label="From" value={from} onChange={setFrom} max={to} />
          </View>
          <View style={styles.field}>
            <DateField label="To" value={to} onChange={setTo} max={today} />
          </View>
          <View style={styles.field}>
            <Select
              label="Branch"
              value={locationId}
              options={[{ label: 'All branches', value: ALL }, ...work.locations.map((l) => ({ label: l.name, value: l.id }))]}
              onChange={setLocationId}
            />
          </View>
        </View>
      </Card>
      <View style={styles.tiles}>
        <StatTile label="Total sales" value={formatPeso(total)} icon="cash-outline" />
        <StatTile label="Transactions" value={String(inRange.length)} icon="receipt-outline" />
        <StatTile
          label="Average sale"
          value={formatPeso(inRange.length ? Math.round(total / inRange.length) : 0)}
          icon="trending-up-outline"
        />
      </View>
      <Card title="Sales per day">
        <BarChart data={chart} formatValue={formatPeso} formatAxis={shortPeso} height={260} />
      </Card>
      <View style={styles.columns}>
        <Card title="By product" style={styles.half}>
          <DataTable rows={productTotals(inRange)} columns={productColumns} rowKey={(p) => p.productId} minWidth={420} initialSort={{ key: 'amount', direction: 'desc' }} />
        </Card>
        <Card title="By payment method" style={styles.half}>
          <DataTable rows={paymentTotals(inRange)} columns={paymentColumns} rowKey={(p) => p.method} minWidth={360} />
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  field: { width: 220 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  half: { flexGrow: 1, flexBasis: 420 },
});

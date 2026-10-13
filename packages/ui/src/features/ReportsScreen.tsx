import {
  addDays,
  borrowingTotals,
  dailyTotals,
  dayRange,
  formatDay,
  formatPeso,
  formatTime,
  localDay,
  paymentTotals,
  productTotals,
  salesBetween,
  salesReportHtml,
  type LoanEntry,
  type PaymentTotal,
  type ProductTotal,
  type Sale,
} from '@sgm/core';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Banner, Card, ScreenHeader, StatTile } from '../Basics';
import { BarChart } from '../BarChart';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { DateField } from '../DateField';
import { Select } from '../Select';
import { useCollection, useServices, useWork } from '../services';
import { spacing } from '../theme';
import { useToast } from '../Toast';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
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

interface PrintStatus {
  /** The dates and branch that were printed; the message shows only while they are still chosen. */
  report: string;
  tone: 'success' | 'warning' | 'info' | 'danger';
  text: string;
}

export function ReportsScreen() {
  const work = useWork();
  const toast = useToast();
  const { printer } = useServices();
  const { data: sales } = useCollection<Sale>('sales');
  const { data: loans } = useCollection<LoanEntry>('loans');
  const today = localDay(new Date());
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [locationId, setLocationId] = useState<string>(ALL);
  const [printing, setPrinting] = useState(false);
  const [printStatus, setPrintStatus] = useState<PrintStatus | null>(null);

  const branch = locationId === ALL ? undefined : locationId;
  // Long ranges would crowd the chart, so it shows at most the last 31 days of the range.
  const chartFrom = from < addDays(to, -30) ? addDays(to, -30) : from;
  const inRange = salesBetween(sales, from, to, branch);
  const total = inRange.reduce((sum, s) => sum + s.total, 0);
  const chart = dailyTotals(inRange, dayRange(chartFrom, to)).map((d) => ({ label: d.label, value: d.total }));
  const borrowing = borrowingTotals(loans, from, to, branch);
  const branchName = branch ? (work.locations.find((l) => l.id === branch)?.name ?? branch) : 'All branches';
  const report = `${from}|${to}|${locationId}`;

  const print = async () => {
    if (printing) return;
    setPrinting(true);
    setPrintStatus(null);
    const what = `The report for ${formatDay(from)}${from === to ? '' : ` to ${formatDay(to)}`} (${branchName})`;
    try {
      const outcome = await printer.printDocument(
        salesReportHtml({ from, to, branchName, sales: inRange, borrowing, printedBy: work.user?.displayName ?? '', printedAt: new Date() }),
      );
      const at = formatTime(new Date().toISOString());
      if (outcome === 'sent') {
        setPrintStatus({ report, tone: 'success', text: `${what} was sent to the printer at ${at}.` });
        toast.show('Report sent to the printer.', 'success');
      } else if (outcome === 'cancelled') {
        setPrintStatus({ report, tone: 'warning', text: 'Printing was cancelled, so nothing was printed.' });
        toast.show('Printing cancelled.');
      } else {
        setPrintStatus({ report, tone: 'info', text: `The print screen opened at ${at}. If no pages come out, check the printer and print again.` });
      }
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).replace(/\.?$/, '.');
      setPrintStatus({
        report,
        tone: 'danger',
        text: `${what} didn't print. ${reason} Check that the printer is on and connected, then press Print report again.`,
      });
      toast.show("The report didn't print.", 'error');
    } finally {
      setPrinting(false);
    }
  };

  useKeyboardShortcuts({ 'Ctrl+P': () => void print() });

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Reports"
        subtitle="Completed sales only; voided sales are left out."
        actions={<Button title="Print report" icon="print-outline" variant="secondary" onPress={print} loading={printing} shortcut="Ctrl+P" />}
      />
      {printStatus?.report === report ? <Banner tone={printStatus.tone}>{printStatus.text}</Banner> : null}
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
          <DataTable rows={productTotals(inRange)} columns={productColumns} rowKey={(p) => p.key} minWidth={420} initialSort={{ key: 'amount', direction: 'desc' }} />
        </Card>
        <Card title="By payment method" style={styles.half}>
          <DataTable rows={paymentTotals(inRange)} columns={paymentColumns} rowKey={(p) => p.method} minWidth={360} />
        </Card>
      </View>
      <Card title="Borrowing">
        <View style={styles.tiles}>
          <StatTile label="Refills put on account" value={formatPeso(borrowing.credit)} icon="time-outline" />
          <StatTile label="Collected on accounts" value={formatPeso(borrowing.collected)} icon="wallet-outline" />
          <StatTile label="Cylinders lent" value={String(borrowing.lent)} icon="arrow-up-circle-outline" />
          <StatTile label="Cylinders returned" value={String(borrowing.returned)} icon="arrow-down-circle-outline" />
        </View>
      </Card>
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

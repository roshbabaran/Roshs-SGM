import {
  accountOf,
  addDays,
  borrowingTotals,
  claimBreakdown,
  customerReport,
  customerReportHtml,
  cylindersByAge,
  dailyTotals,
  dayRange,
  debtByAge,
  discountTotal,
  dueForRefill,
  formatDateTime,
  formatDay,
  formatPeso,
  formatTime,
  lateEnough,
  localDay,
  owedByDay,
  paymentTotals,
  productTotals,
  refillRhythm,
  returnTotals,
  RHYTHM_PURCHASES,
  salesBetween,
  salesReportHtml,
  worksAt,
  worksEverywhere,
  type Claim,
  type ClaimItemTotal,
  type Customer,
  type CustomerActivity,
  type CustomerReportRow,
  type LoanEntry,
  type PaymentTotal,
  type Product,
  type ProductTotal,
  type RefillRhythm,
  type Sale,
} from '@sgm/core';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AgeChart } from '../AgeChart';
import { Badge, Banner, Card, ScreenHeader, SegmentedControl, StatTile } from '../Basics';
import { BarChart } from '../BarChart';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { DateField } from '../DateField';
import { LineChart } from '../LineChart';
import { PagedList } from '../PagedList';
import { MultiSelect, Select } from '../Select';
import { useCollection, useServices, useWork } from '../services';
import { Text } from '../Text';
import { spacing, useTheme } from '../theme';
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

const customerColumns: Column<CustomerReportRow>[] = [
  { key: 'name', title: 'Customer', flex: 2, text: (r) => r.customer.name },
  { key: 'sales', title: 'Sales', width: 70, align: 'right', text: (r) => String(r.sales), sortValue: (r) => r.sales },
  { key: 'spent', title: 'Bought', width: 120, align: 'right', text: (r) => formatPeso(r.spent), sortValue: (r) => r.spent },
  { key: 'discounts', title: 'Discounts', width: 110, align: 'right', text: (r) => formatPeso(r.discounts), sortValue: (r) => r.discounts },
  { key: 'payments', title: 'Paid back', width: 110, align: 'right', text: (r) => formatPeso(r.payments), sortValue: (r) => r.payments },
  { key: 'owed', title: 'Owes now', width: 110, align: 'right', text: (r) => formatPeso(r.owed), sortValue: (r) => r.owed },
  { key: 'out', title: 'Cyl. out', width: 80, align: 'right', text: (r) => String(r.cylindersOut), sortValue: (r) => r.cylindersOut },
  { key: 'pickup', title: 'To pick up', width: 90, align: 'right', text: (r) => String(r.toPickUp), sortValue: (r) => r.toPickUp },
  { key: 'returns', title: 'Returns', width: 80, align: 'right', text: (r) => String(r.returns), sortValue: (r) => r.returns },
];

const returnedColumns: Column<ClaimItemTotal>[] = [
  { key: 'name', title: 'Item', flex: 2, text: (r) => r.name },
  { key: 'qty', title: 'Qty', width: 70, align: 'right', text: (r) => String(r.qty), sortValue: (r) => r.qty },
  { key: 'amount', title: 'Refunded', width: 120, align: 'right', text: (r) => formatPeso(r.amount), sortValue: (r) => r.amount },
];

const defectiveColumns: Column<ClaimItemTotal>[] = [
  { key: 'name', title: 'Item', flex: 2, text: (r) => r.name },
  { key: 'qty', title: 'Exchanged', width: 90, align: 'right', text: (r) => String(r.qty), sortValue: (r) => r.qty },
  { key: 'lostKg', title: 'Gas lost', width: 90, align: 'right', text: (r) => (r.lostKg === undefined ? '—' : `${r.lostKg} kg`), sortValue: (r) => r.lostKg ?? 0 },
  { key: 'amount', title: 'Paid', width: 110, align: 'right', text: (r) => formatPeso(r.amount), sortValue: (r) => r.amount },
];

const activityColumns: Column<CustomerActivity>[] = [
  { key: 'at', title: 'When', width: 150, text: (a) => formatDateTime(a.at), sortValue: (a) => a.at },
  { key: 'customer', title: 'Customer', flex: 1, text: (a) => a.customerName },
  { key: 'what', title: 'What', width: 150, text: (a) => a.what },
  { key: 'details', title: 'Details', flex: 2, text: (a) => [a.receiptNo, a.details].filter(Boolean).join(' · ') },
  { key: 'amount', title: 'Amount', width: 120, align: 'right', text: (a) => (a.amount === null ? '' : formatPeso(a.amount)), sortValue: (a) => a.amount ?? 0 },
];

const ALL = 'all';

type Tab = 'sales' | 'customers';

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
  const { data: allSales } = useCollection<Sale>('sales');
  const { data: allLoans } = useCollection<LoanEntry>('loans');
  const { data: allClaims } = useCollection<Claim>('claims');
  const { data: customers } = useCollection<Customer>('borrowers');
  const { data: products } = useCollection<Product>('products');
  const today = localDay(new Date());
  const [tab, setTab] = useState<Tab>('sales');
  /** The customers in the customer report; null for all of them. */
  const [customerIds, setCustomerIds] = useState<string[] | null>(null);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [locationId, setLocationId] = useState<string>(ALL);
  const [printing, setPrinting] = useState(false);
  const [printStatus, setPrintStatus] = useState<PrintStatus | null>(null);

  // A branch manager sees only the branches they are assigned to; "All" means all of theirs.
  const everywhere = !!work.user && worksEverywhere(work.user);
  const myLocations = work.locations.filter((l) => worksAt(work.user, l.id));
  const mine = <T extends { locationId: string }>(rows: T[]) => (everywhere ? rows : rows.filter((r) => worksAt(work.user, r.locationId)));
  const sales = mine(allSales);
  const loans = mine(allLoans);
  const claims = mine(allClaims);
  const allLabel = everywhere ? 'All branches' : 'All my branches';
  const branch = locationId === ALL ? undefined : locationId;
  // Long ranges would crowd the chart, so it shows at most the last 31 days of the range.
  const chartFrom = from < addDays(to, -30) ? addDays(to, -30) : from;
  const inRange = salesBetween(sales, from, to, branch);
  const total = inRange.reduce((sum, s) => sum + s.total, 0);
  const chart = dailyTotals(inRange, dayRange(chartFrom, to)).map((d) => ({ label: d.label, value: d.total }));
  const borrowing = borrowingTotals(loans, from, to, branch);
  const returns = returnTotals(claims, from, to, branch);
  const claimItems = claimBreakdown(claims, sales, from, to, branch);
  const discounts = discountTotal(inRange);
  const branchName = branch
    ? (work.locations.find((l) => l.id === branch)?.name ?? branch)
    : everywhere
      ? allLabel
      : myLocations.map((l) => l.name).join(', ');
  const productName = (id: string | undefined) => products.find((p) => p.id === id)?.name ?? 'a product';
  const byCustomer = customerReport({ customers, sales, loans, claims, from, to, locationId: branch, customerIds: customerIds ?? undefined, productName });
  // What the chosen customers (or every named customer) bought each day.
  const customerSales = inRange.filter((sale) => sale.borrowerId && (customerIds === null || customerIds.includes(sale.borrowerId)));
  const customerChart = dailyTotals(customerSales, dayRange(chartFrom, to)).map((d) => ({ label: d.label, value: d.total }));
  const customersLabel =
    customerIds === null
      ? 'All customers'
      : customers
          .filter((c) => customerIds.includes(c.id))
          .map((c) => c.name)
          .join(', ');
  const report = `${tab}|${from}|${to}|${locationId}|${customerIds?.join(',') ?? ALL}`;

  const print = async () => {
    if (printing) return;
    setPrinting(true);
    setPrintStatus(null);
    const what = `The ${tab === 'customers' ? 'customer ' : ''}report for ${formatDay(from)}${from === to ? '' : ` to ${formatDay(to)}`} (${branchName})`;
    try {
      const printedBy = work.user?.displayName ?? '';
      const outcome = await printer.printDocument(
        tab === 'sales'
          ? salesReportHtml({ from, to, branchName, sales: inRange, borrowing, returns, claimItems, printedBy, printedAt: new Date() })
          : customerReportHtml({ from, to, branchName, customersLabel, rows: byCustomer.rows, activity: byCustomer.activity, printedBy, printedAt: new Date() }),
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
        subtitle={tab === 'sales' ? 'Completed sales only; voided sales are left out.' : 'Sales, borrowing, pick ups, returns and exchanges of named customers.'}
        actions={
          <>
            <SegmentedControl
              accessibilityLabel="Report"
              options={[
                { label: 'Sales', value: 'sales' },
                { label: 'Customers', value: 'customers' },
              ]}
              value={tab}
              onChange={setTab}
            />
            <Button
              title="Print report"
              icon="print-outline"
              variant="secondary"
              onPress={print}
              loading={printing}
              shortcut="Ctrl+P"
              disabled={tab === 'customers' && customerIds?.length === 0}
            />
          </>
        }
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
              options={[{ label: allLabel, value: ALL }, ...myLocations.map((l) => ({ label: l.name, value: l.id }))]}
              onChange={setLocationId}
              searchable
              searchPlaceholder="Search branches"
            />
          </View>
          {tab === 'customers' ? (
            <View style={styles.wideField}>
              <MultiSelect
                label="Customers"
                value={customerIds}
                options={[...customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ label: c.name, value: c.id, hint: c.phone }))}
                onChange={setCustomerIds}
                allLabel="All customers"
                noun="customer"
                searchable
                searchPlaceholder="Search customers by name or phone"
              />
            </View>
          ) : null}
        </View>
      </Card>
      {tab === 'customers' ? (
        <>
          <CustomerCharts
            rows={byCustomer.rows}
            perDay={customerChart}
            customers={customerIds === null ? customers : customers.filter((c) => customerIds.includes(c.id))}
            sales={sales}
            loans={loans}
            branch={branch}
            from={chartFrom}
            to={to}
            today={today}
            productName={productName}
          />
          <Card title="Customers">
            <DataTable
              rows={byCustomer.rows}
              columns={customerColumns}
              rowKey={(r) => r.customer.id}
              minWidth={900}
              emptyText="No activity for these customers in this period."
              searchPlaceholder="Search customers"
            />
          </Card>
          <Card title="Activity">
            <DataTable
              rows={byCustomer.activity}
              columns={activityColumns}
              rowKey={(a) => a.id}
              minWidth={820}
              pageSize={25}
              emptyText="No activity for these customers in this period."
              searchPlaceholder="Search activity"
              initialSort={{ key: 'at', direction: 'desc' }}
            />
          </Card>
        </>
      ) : (
        <SalesReport
          total={total}
          count={inRange.length}
          discounts={discounts}
          chart={chart}
          inRange={inRange}
          borrowing={borrowing}
          returns={returns}
          claimItems={claimItems}
        />
      )}
    </ScrollView>
  );
}

function SalesReport({
  total,
  count,
  discounts,
  chart,
  inRange,
  borrowing,
  returns,
  claimItems,
}: {
  total: number;
  count: number;
  discounts: number;
  chart: { label: string; value: number }[];
  inRange: Sale[];
  borrowing: ReturnType<typeof borrowingTotals>;
  returns: ReturnType<typeof returnTotals>;
  claimItems: ReturnType<typeof claimBreakdown>;
}) {
  return (
    <>
      <View style={styles.tiles}>
        <StatTile label="Total sales" value={formatPeso(total)} icon="cash-outline" />
        <StatTile label="Transactions" value={String(count)} icon="receipt-outline" />
        <StatTile label="Average sale" value={formatPeso(count ? Math.round(total / count) : 0)} icon="trending-up-outline" />
        <StatTile label="Discounts given" value={formatPeso(discounts)} icon="pricetag-outline" />
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
          <StatTile label="Sales on credit" value={formatPeso(borrowing.credit)} icon="time-outline" />
          <StatTile
            label="Collections"
            value={formatPeso(borrowing.collected)}
            hint={borrowing.byCheque > 0 ? `${formatPeso(borrowing.byCheque)} by post-dated cheque` : undefined}
            icon="wallet-outline"
          />
          {borrowing.bounced > 0 ? <StatTile label="Bounced cheques" value={formatPeso(borrowing.bounced)} icon="alert-circle-outline" tone="danger" /> : null}
          <StatTile label="Borrowed cylinders" value={String(borrowing.lent)} icon="arrow-up-circle-outline" />
          <StatTile label="Returned cylinders" value={String(borrowing.returned)} icon="arrow-down-circle-outline" />
        </View>
      </Card>
      <Card title="Returns and defectives">
        <View style={styles.tiles}>
          <StatTile
            label="Returns"
            value={String(returns.returns)}
            hint={`${formatPeso(returns.refunded)} refunded${returns.wholeSales > 0 ? ` · ${returns.wholeSales} whole sale${returns.wholeSales === 1 ? '' : 's'} voided` : ''}`}
            icon="return-down-back-outline"
          />
          <StatTile label="Defective exchanges" value={String(returns.defectives)} hint={`${formatPeso(returns.charged)} paid by customers`} icon="construct-outline" />
        </View>
        <View style={[styles.columns, styles.breakdown]}>
          <View style={styles.half}>
            <Text variant="label">Items returned</Text>
            <DataTable
              rows={claimItems.returned}
              columns={returnedColumns}
              rowKey={(r) => r.key}
              minWidth={360}
              emptyText="No returns in this period."
              initialSort={{ key: 'qty', direction: 'desc' }}
            />
          </View>
          <View style={styles.half}>
            <Text variant="label">Defective exchanges</Text>
            <DataTable
              rows={claimItems.defective}
              columns={defectiveColumns}
              rowKey={(r) => r.key}
              minWidth={420}
              emptyText="No defective exchanges in this period."
              initialSort={{ key: 'qty', direction: 'desc' }}
            />
          </View>
        </View>
      </Card>
    </>
  );
}

const cylinderCount = (n: number) => `${n} ${n === 1 ? 'cylinder' : 'cylinders'}`;
const dayCount = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
/** Older debt and cylinders out longer get a stronger badge. */
const ageTone = (days: number) => (days > 60 ? 'danger' : days > 30 ? 'warning' : 'neutral');

/**
 * The customer report's charts. For several customers: what they bought each
 * day, how old what they owe is, how long lent cylinders have been out, and
 * the regulars who are late for a refill. For one customer, their own story.
 * Owing, cylinders and refills are as of today, at every branch the person can see.
 */
function CustomerCharts({
  rows,
  perDay,
  customers,
  sales,
  loans,
  branch,
  from,
  to,
  today,
  productName,
}: {
  rows: CustomerReportRow[];
  perDay: { label: string; value: number }[];
  /** The customers chosen in the report. */
  customers: Customer[];
  sales: Sale[];
  loans: LoanEntry[];
  branch: string | undefined;
  /** The days the charts show. */
  from: string;
  to: string;
  today: string;
  productName: (id: string | undefined) => string;
}) {
  const accounts = useMemo(() => {
    const byCustomer = new Map<string, LoanEntry[]>();
    for (const entry of loans) {
      const theirs = byCustomer.get(entry.borrowerId);
      if (theirs) theirs.push(entry);
      else byCustomer.set(entry.borrowerId, [entry]);
    }
    return customers.map((c) => accountOf(c, byCustomer.get(c.id) ?? []));
  }, [customers, loans]);
  const debt = useMemo(() => debtByAge(accounts, today), [accounts, today]);
  const cylinders = useMemo(() => cylindersByAge(accounts, today), [accounts, today]);
  const due = useMemo(() => dueForRefill(customers, sales, today, branch), [customers, sales, today, branch]);

  if (customers.length === 1 && accounts[0]) {
    return <OneCustomer row={rows[0]} account={accounts[0]} perDay={perDay} sales={sales} branch={branch} from={from} to={to} today={today} productName={productName} />;
  }

  const spent = rows.reduce((sum, r) => sum + r.spent, 0);
  const owed = rows.reduce((sum, r) => sum + Math.max(0, r.owed), 0);
  const out = rows.reduce((sum, r) => sum + r.cylindersOut, 0);
  return (
    <>
      <View style={styles.tiles}>
        <StatTile label="Customers shown" value={String(rows.length)} icon="people-outline" />
        <StatTile label="Bought in the period" value={formatPeso(spent)} icon="cash-outline" />
        <StatTile label="Owed now" value={formatPeso(owed)} icon="time-outline" tone={owed > 0 ? 'warning' : undefined} />
        <StatTile label="Cylinders still out" value={String(out)} icon="arrow-up-circle-outline" />
      </View>
      <Card title="Customer sales per day">
        <BarChart data={perDay} formatValue={formatPeso} formatAxis={shortPeso} height={220} />
      </Card>
      <View style={styles.columns}>
        <Card title="How old the debt is" style={styles.half}>
          <Text variant="small" muted>
            What is owed today, by how long ago it was bought on credit. Payments pay off the oldest first.
          </Text>
          <AgeChart
            groups={debt}
            formatValue={formatPeso}
            detail={(p) => `Oldest unpaid from ${formatDay(localDay(p.since))}, ${dayCount(p.days)} ago`}
            emptyText="No one owes anything."
          />
        </Card>
        <Card title="How long cylinders have been out" style={styles.half}>
          <Text variant="small" muted>
            Lent cylinders not back yet, by how long ago they were lent. Returns close the oldest first.
          </Text>
          <AgeChart
            groups={cylinders}
            formatValue={cylinderCount}
            detail={(p) => `${productName(p.productId)} · lent ${formatDay(localDay(p.since))}, ${dayCount(p.days)} ago`}
            emptyText="No cylinders are out."
          />
        </Card>
      </View>
      <Card title="Due for a refill">
        <Text variant="small" muted>
          {`Regulars well past their usual days between LPG purchases${branch ? ' at this branch' : ''}, the latest first. It takes ${RHYTHM_PURCHASES} days with LPG to learn how often someone buys.`}
        </Text>
        <RefillDue rhythms={due} />
      </Card>
    </>
  );
}

/** Each late regular: their usual gap and how far past it they are, as one bar. */
function RefillDue({ rhythms }: { rhythms: RefillRhythm[] }) {
  const { colors } = useTheme();
  if (rhythms.length === 0) return <Text muted>No regulars are late for a refill.</Text>;
  const longest = Math.max(...rhythms.map((r) => r.daysSince));
  return (
    <View style={styles.refills}>
      <View style={styles.legend} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: colors.primary }]} />
          <Text variant="small" muted>
            Usual days between refills
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: colors.warning }]} />
          <Text variant="small" muted>
            Days late
          </Text>
        </View>
      </View>
      <PagedList
        items={rhythms}
        keyOf={(r) => r.customer.id}
        renderItem={(r) => (
          <View
            accessible
            accessibilityLabel={`${r.customer.name}: usually every ${dayCount(r.usualGap)}, last bought ${dayCount(r.daysSince)} ago, ${dayCount(r.late)} late.`}
            style={[styles.refill, { borderBottomColor: colors.border }]}
          >
            <View style={styles.refillText}>
              <View style={styles.flex}>
                <Text>{r.customer.name}</Text>
                <Text variant="small" muted>
                  {`Every ${dayCount(r.usualGap)} · last bought ${formatDay(r.lastDay)}${r.customer.phone ? ` · ${r.customer.phone}` : ''}`}
                </Text>
              </View>
              <Badge label={`${dayCount(r.late)} late`} tone="warning" icon="time-outline" />
            </View>
            <View style={styles.meter}>
              <View style={[styles.meterUsual, { flexGrow: r.usualGap, backgroundColor: colors.primary }]} />
              <View style={[styles.meterLate, { flexGrow: r.late, backgroundColor: colors.warning }]} />
              <View style={{ flexGrow: longest - r.daysSince }} />
            </View>
          </View>
        )}
      />
    </View>
  );
}

/** One customer's own story: what they owed and bought each day, what is still unpaid, and the cylinders they have. */
function OneCustomer({
  row,
  account,
  perDay,
  sales,
  branch,
  from,
  to,
  today,
  productName,
}: {
  row: CustomerReportRow | undefined;
  account: ReturnType<typeof accountOf>;
  perDay: { label: string; value: number }[];
  sales: Sale[];
  branch: string | undefined;
  from: string;
  to: string;
  today: string;
  productName: (id: string | undefined) => string;
}) {
  const { colors } = useTheme();
  const customer = account.borrower;
  const rhythm = refillRhythm(customer, sales, today, branch);
  const owed = owedByDay(account.entries, from, to).map((d) => ({ label: formatDay(d.day), value: d.owed }));
  const receipt = (saleId: string | undefined) => sales.find((s) => s.id === saleId)?.receiptNo;
  const age = (iso: string) => Math.max(0, dayRange(localDay(iso), today).length - 1);
  return (
    <>
      <View style={styles.tiles}>
        <StatTile label="Bought in the period" value={formatPeso(row?.spent ?? 0)} hint={`${row?.sales ?? 0} sales`} icon="cash-outline" />
        <StatTile label="Owes now" value={formatPeso(account.owed)} icon="time-outline" tone={account.owed > 0 ? 'warning' : undefined} />
        <StatTile label="Cylinders out" value={String(account.cylindersOut)} icon="arrow-up-circle-outline" />
        <StatTile
          label="Buys LPG"
          value={rhythm ? `Every ${dayCount(rhythm.usualGap)}` : 'Not known yet'}
          hint={
            !rhythm
              ? `Needs ${RHYTHM_PURCHASES} days with LPG to tell`
              : lateEnough(rhythm)
                ? `${dayCount(rhythm.late)} late for a refill`
                : rhythm.late > 0
                  ? 'Due for a refill now'
                  : `Next refill around ${formatDay(rhythm.nextDay)}`
          }
          icon="repeat-outline"
          tone={rhythm && lateEnough(rhythm) ? 'warning' : undefined}
        />
      </View>
      <View style={styles.columns}>
        <Card title="What they owed, day by day" style={styles.half}>
          <LineChart data={owed} formatValue={formatPeso} formatAxis={shortPeso} />
        </Card>
        <Card title="What they bought, day by day" style={styles.half}>
          {perDay.some((d) => d.value > 0) ? (
            <BarChart data={perDay} formatValue={formatPeso} formatAxis={shortPeso} height={220} />
          ) : (
            <Text muted>Nothing bought in this period.</Text>
          )}
        </Card>
      </View>
      <View style={styles.columns}>
        <Card title="Unpaid sales on credit" style={styles.half}>
          {account.openCredits.length === 0 ? (
            <Text muted>Nothing unpaid.</Text>
          ) : (
            <PagedList
              items={account.openCredits}
              keyOf={(c) => c.entry.id}
              renderItem={(c) => (
                <View style={[styles.listRow, { borderBottomColor: colors.border }]}>
                  <View style={styles.flex}>
                    <Text>{formatDay(localDay(c.entry.occurredAt))}</Text>
                    <Text variant="small" muted>
                      {[receipt(c.entry.saleId) ? `Receipt ${receipt(c.entry.saleId)}` : '', c.left < c.entry.amount ? `part of ${formatPeso(c.entry.amount)} paid` : '']
                        .filter(Boolean)
                        .join(' · ') || 'Sale on credit'}
                    </Text>
                  </View>
                  <Badge label={`${dayCount(age(c.entry.occurredAt))} old`} tone={ageTone(age(c.entry.occurredAt))} />
                  <Text weight="600" numeric style={styles.amount}>
                    {formatPeso(c.left)}
                  </Text>
                </View>
              )}
            />
          )}
        </Card>
        <Card title="Cylinders they have" style={styles.half}>
          {account.openCylinders.length === 0 ? (
            <Text muted>No cylinders out.</Text>
          ) : (
            <PagedList
              items={account.openCylinders}
              keyOf={(c) => c.entry.id}
              renderItem={(c) => (
                <View style={[styles.listRow, { borderBottomColor: colors.border }]}>
                  <View style={styles.flex}>
                    <Text>{productName(c.productId)}</Text>
                    <Text variant="small" muted>
                      {`Lent ${formatDay(localDay(c.entry.occurredAt))}`}
                    </Text>
                  </View>
                  <Badge label={`${dayCount(age(c.entry.occurredAt))} out`} tone={ageTone(age(c.entry.occurredAt))} />
                  <Text weight="600" numeric style={styles.amount}>
                    {cylinderCount(c.left)}
                  </Text>
                </View>
              )}
            />
          )}
        </Card>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  field: { width: 220 },
  wideField: { width: 300 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  half: { flexGrow: 1, flexShrink: 1, flexBasis: 420, gap: spacing.sm },
  flex: { flex: 1 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  amount: { minWidth: 96, textAlign: 'right' },
  refills: { gap: spacing.sm },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  refill: { gap: spacing.xs, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  refillText: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  // The 2px gap between the usual and late parts is the card showing through.
  meter: { flexDirection: 'row', height: 10, gap: 2 },
  meterUsual: { flexBasis: 0 },
  meterLate: { flexBasis: 0, borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  breakdown: { marginTop: spacing.lg },
});

import {
  formatDateTime,
  formatPeso,
  localDay,
  PAYMENT_LABELS,
  saleProgress,
  voidFormSchema,
  voidSale,
  type Claim,
  type Customer,
  type Sale,
  type User,
} from '@sgm/core';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Banner, Card, ScreenHeader } from '../Basics';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { DateField } from '../DateField';
import { Dialog } from '../Dialog';
import { Icon } from '../Icon';
import { Select } from '../Select';
import { useCollection, useServices, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { spacing, useTheme } from '../theme';
import { useToast } from '../Toast';
import { useZodForm } from '../useZodForm';
import { ReceiptScanDialog } from './ReceiptScanDialog';
import { ReceiptDialog } from './receipts';

const itemsText = (sale: Sale) => sale.lines.map((l) => `${l.qty}× ${l.name}`).join(', ');

/** The customer, and the name written on a scanned receipt when it is different. */
const namesOf = (sale: Sale): { name: string; written?: string } => {
  const written = sale.registeredName;
  if (!sale.borrowerName) return { name: written ?? '' };
  return written && written.toLowerCase() !== sale.borrowerName.toLowerCase() ? { name: sale.borrowerName, written } : { name: sale.borrowerName };
};

/** A sale entered after it happened: when it happened, whether its time was on the receipt, and when it was entered. */
const timeNote = (sale: Sale): string =>
  [sale.timeEstimated ? 'Time not on receipt' : '', sale.recordedAt ? `Entered ${formatDateTime(sale.recordedAt)}` : ''].filter(Boolean).join(' · ');

const ANY_CUSTOMER = 'any';
const NO_CUSTOMER = 'none';

export function SalesScreen() {
  const work = useWork();
  const { ocr } = useServices();
  const toast = useToast();
  const { colors } = useTheme();
  const { data: sales } = useCollection<Sale>('sales');
  const { data: users } = useCollection<User>('users');
  const { data: claims } = useCollection<Claim>('claims');
  const { data: customers } = useCollection<Customer>('borrowers');
  const today = localDay(new Date());
  const [customerId, setCustomerId] = useState<string>(ANY_CUSTOMER);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [selected, setSelected] = useState<Sale | null>(null);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const [scanning, setScanning] = useState(false);
  const canScan = !!ocr && work.can('pos.sell');

  const rows = sales
    .filter((s) => s.locationId === work.locationId)
    .filter((s) => customerId === ANY_CUSTOMER || (customerId === NO_CUSTOMER ? !s.borrowerId : s.borrowerId === customerId))
    .filter((s) => {
      const day = localDay(s.createdAt);
      return day >= from && day <= to;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const completed = rows.filter((s) => s.status === 'completed');
  const total = completed.reduce((sum, s) => sum + s.total, 0);
  const cashier = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  /** Prepaid orders still waiting, and returns, as a short note. */
  const claimNote = (s: Sale): string => {
    const progress = saleProgress(s, claims);
    const toPickUp = progress.reduce((n, p) => n + p.toPickUp, 0);
    const returned = progress.reduce((n, p) => n + p.returned, 0);
    return [s.prepaid ? (toPickUp > 0 ? `Prepaid, ${toPickUp} to pick up` : 'Prepaid, picked up') : '', returned > 0 && s.status === 'completed' ? `${returned} returned` : '']
      .filter(Boolean)
      .join(' · ');
  };

  const columns: Column<Sale>[] = [
    { key: 'receipt', title: 'Receipt', width: 150, text: (s) => s.receiptNo },
    {
      key: 'time',
      title: 'Time',
      width: 180,
      text: (s) => `${formatDateTime(s.createdAt)} ${timeNote(s)}`,
      sortValue: (s) => s.createdAt,
      render: (s) => (
        <View style={styles.cellText}>
          <Text>{formatDateTime(s.createdAt)}</Text>
          {timeNote(s) ? (
            <Text variant="small" muted>
              {timeNote(s)}
            </Text>
          ) : null}
        </View>
      ),
    },
    {
      key: 'customer',
      title: 'Customer',
      width: 170,
      // Searching by name finds the name written on a scanned receipt too.
      text: (s) => [namesOf(s).name, namesOf(s).written].filter(Boolean).join(' '),
      render: (s) => (
        <View style={styles.cellText}>
          <Text>{namesOf(s).name}</Text>
          {namesOf(s).written ? (
            <Text variant="small" muted>
              {`Written: ${namesOf(s).written}`}
            </Text>
          ) : null}
        </View>
      ),
    },
    {
      key: 'items',
      title: 'Items',
      flex: 1,
      text: (s) => `${itemsText(s)} ${claimNote(s)}`,
      render: (s) => (
        <View style={styles.cellText}>
          <Text>{itemsText(s)}</Text>
          {claimNote(s) ? (
            <Text variant="small" muted>
              {claimNote(s)}
            </Text>
          ) : null}
        </View>
      ),
    },
    { key: 'total', title: 'Total', width: 120, align: 'right', text: (s) => formatPeso(s.total), sortValue: (s) => s.total },
    { key: 'payment', title: 'Payment', width: 120, text: (s) => PAYMENT_LABELS[s.payment.method] },
    { key: 'cashier', title: 'Cashier', width: 150, text: (s) => cashier(s.cashierId) },
    {
      key: 'status',
      title: 'Status',
      width: 130,
      sortValue: (s) => s.status,
      render: (s) => (
        <View style={styles.statusCell}>
          {s.status === 'voided' ? <Badge label="Voided" tone="danger" /> : <Badge label="Completed" tone="success" />}
          <Icon name={s.receivedAt ? 'cloud-done-outline' : 'cloud-upload-outline'} size={16} color={s.receivedAt ? colors.success : colors.warning} />
        </View>
      ),
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Transactions"
        subtitle={`${work.location?.name ?? ''} · ${completed.length} sales · ${formatPeso(total)}`}
        actions={canScan ? <Button title="Scan receipt" icon="scan-outline" variant="secondary" size="sm" onPress={() => setScanning(true)} /> : null}
      />
      <Card padded>
        <View style={styles.filters}>
          <View style={styles.dateField}>
            <DateField label="From" value={from} onChange={setFrom} max={to} />
          </View>
          <View style={styles.dateField}>
            <DateField label="To" value={to} onChange={setTo} max={today} />
          </View>
          <View style={styles.customerField}>
            <Select
              label="Customer"
              value={customerId}
              options={[
                { label: 'Everyone', value: ANY_CUSTOMER },
                { label: 'Sales without a name', value: NO_CUSTOMER },
                ...[...customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ label: c.name, value: c.id, hint: c.phone })),
              ]}
              onChange={setCustomerId}
            />
          </View>
        </View>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(s) => s.id}
          onRowPress={setSelected}
          searchPlaceholder="Search receipts, names, items or cashier"
          emptyText={customerId === ANY_CUSTOMER ? 'No sales on these dates.' : 'No sales for this customer on these dates. Try a wider date range.'}
          minWidth={1180}
        />
      </Card>

      <ReceiptDialog
        sale={selected}
        onClose={() => setSelected(null)}
        actions={
          selected && selected.status === 'completed' && work.can('sales.void') ? (
            <Button
              title="Void sale"
              variant="danger"
              icon="close-circle-outline"
              onPress={() => {
                setVoiding(selected);
                setSelected(null);
              }}
            />
          ) : null
        }
      />
      <VoidDialog sale={voiding} onClose={() => setVoiding(null)} />
      {canScan ? (
        <ReceiptScanDialog
          visible={scanning}
          onClose={() => setScanning(false)}
          onSaved={(sale) => {
            setScanning(false);
            // Show the sale it saved, even when it is dated before the days on screen.
            const day = localDay(sale.createdAt);
            if (day < from) setFrom(day);
            if (day > to) setTo(day);
            toast.show(`Sale ${sale.receiptNo} saved from the receipt.`, 'success');
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function VoidDialog({ sale, onClose }: { sale: Sale | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const form = useZodForm(voidFormSchema, { reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    form.reset({ reason: '' });
    setError(null);
    onClose();
  };

  const submit = form.handleSubmit(async ({ reason }) => {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      await voidSale(work.ctx, sale.id, reason);
      toast.show(`Sale ${sale.receiptNo} voided. Stock was put back.`, 'success');
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog
      visible={!!sale}
      title={`Void sale ${sale?.receiptNo ?? ''}`}
      onClose={close}
      width={460}
      dismissable={!busy}
      actions={
        <>
          <Button title="Keep sale" variant="secondary" onPress={close} disabled={busy} />
          <Button title="Void sale" variant="danger" onPress={submit} loading={busy} />
        </>
      }
    >
      <Text>
        The sale stays in the records marked as voided, and its {sale ? formatPeso(sale.total) : ''} is taken out of the totals. The stock goes back on the shelf.
        {sale?.borrowerName ? ` Anything it put on ${sale.borrowerName}'s account, or lent to them, is taken off it too.` : ''}
        {sale?.downPayment ? ` Give back the ${formatPeso(sale.downPayment.amount)} they paid when they took it.` : ''}
      </Text>
      <TextField
        label="Reason"
        value={form.values.reason}
        onChangeText={(v) => form.set('reason', v)}
        error={form.errors.reason}
        multiline
        autoFocus
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  filters: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
  dateField: { width: 200 },
  customerField: { width: 260 },
  statusCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  /** Fills the cell, so long text is cut short instead of running into the next column. */
  cellText: { alignSelf: 'stretch' },
});

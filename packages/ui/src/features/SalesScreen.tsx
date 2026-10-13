import {
  formatDateTime,
  formatPeso,
  localDay,
  PAYMENT_LABELS,
  voidFormSchema,
  voidSale,
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
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { spacing, useTheme } from '../theme';
import { useToast } from '../Toast';
import { useZodForm } from '../useZodForm';
import { ReceiptDialog } from './receipts';

const itemsText = (sale: Sale) => sale.lines.map((l) => `${l.qty}× ${l.name}`).join(', ');

export function SalesScreen() {
  const work = useWork();
  const { colors } = useTheme();
  const { data: sales } = useCollection<Sale>('sales');
  const { data: users } = useCollection<User>('users');
  const today = localDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [selected, setSelected] = useState<Sale | null>(null);
  const [voiding, setVoiding] = useState<Sale | null>(null);

  const rows = sales
    .filter((s) => s.locationId === work.locationId)
    .filter((s) => {
      const day = localDay(s.createdAt);
      return day >= from && day <= to;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const completed = rows.filter((s) => s.status === 'completed');
  const total = completed.reduce((sum, s) => sum + s.total, 0);
  const cashier = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  const columns: Column<Sale>[] = [
    { key: 'receipt', title: 'Receipt', width: 150, text: (s) => s.receiptNo },
    { key: 'time', title: 'Time', width: 190, text: (s) => formatDateTime(s.createdAt), sortValue: (s) => s.createdAt },
    {
      key: 'items',
      title: 'Items',
      flex: 1,
      text: (s) => `${itemsText(s)} ${s.borrowerName ?? ''}`,
      render: (s) => (
        <View style={styles.cellText}>
          <Text numberOfLines={1}>{itemsText(s)}</Text>
          {s.borrowerName ? (
            <Text variant="small" muted numberOfLines={1}>
              Borrower: {s.borrowerName}
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
      <ScreenHeader title="Sales" subtitle={`${work.location?.name ?? ''} · ${completed.length} sales · ${formatPeso(total)}`} />
      <Card padded>
        <View style={styles.filters}>
          <View style={styles.dateField}>
            <DateField label="From" value={from} onChange={setFrom} max={to} />
          </View>
          <View style={styles.dateField}>
            <DateField label="To" value={to} onChange={setTo} max={today} />
          </View>
        </View>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(s) => s.id}
          onRowPress={setSelected}
          searchPlaceholder="Search receipts, items, borrowers or cashier"
          emptyText="No sales on these dates."
          minWidth={1020}
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
  statusCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  /** Fills the cell, so long text is cut short instead of running into the next column. */
  cellText: { alignSelf: 'stretch' },
});

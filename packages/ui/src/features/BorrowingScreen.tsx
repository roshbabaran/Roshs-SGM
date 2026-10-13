import {
  borrowerAccounts,
  cylinderReturnFormSchema,
  daysAgo,
  formatDateTime,
  formatDay,
  formatPeso,
  lend,
  lendFormSchema,
  lendLine,
  levelOf,
  loanPaymentFormSchema,
  LOAN_LABELS,
  localDay,
  NEW_BORROWER,
  PAYMENT_LABELS,
  payLoan,
  returnCylinder,
  saveBorrower,
  stockByProduct,
  type Borrower,
  type BorrowerAccount,
  type Centavos,
  type LendInput,
  type LoanEntry,
  type Payment,
  type Product,
  type Sale,
  type StockMovement,
  type User,
} from '@sgm/core';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { z } from 'zod';

import { Badge, Banner, Card, EmptyState, ScreenHeader, SegmentedControl, StatTile } from '../Basics';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { Dialog } from '../Dialog';
import { Select } from '../Select';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useToast } from '../Toast';
import { useZodForm } from '../useZodForm';
import { PaymentDialog } from './PaymentDialog';
import { ReceiptDialog } from './receipts';

/** "Oct 8 (5 days ago)" */
function sinceText(iso: string): string {
  const days = daysAgo(iso);
  return `${formatDay(localDay(iso))} (${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`})`;
}

function owedText(owed: Centavos): string {
  if (owed < 0) return `Overpaid ${formatPeso(-owed)}`;
  return owed === 0 ? '—' : formatPeso(owed);
}

function signedPeso(amount: Centavos): string {
  return amount === 0 ? '' : `${amount > 0 ? '+' : '−'}${formatPeso(Math.abs(amount))}`;
}

/** Lookups shared by the screen and its dialogs. */
function useBorrowingData() {
  const { data: borrowers } = useCollection<Borrower>('borrowers');
  const { data: loans } = useCollection<LoanEntry>('loans');
  const { data: products } = useCollection<Product>('products');
  const { data: sales } = useCollection<Sale>('sales');
  const { data: users } = useCollection<User>('users');
  const accounts = useMemo(() => borrowerAccounts(borrowers, loans), [borrowers, loans]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const salesById = useMemo(() => new Map(sales.map((s) => [s.id, s])), [sales]);

  const productName = (id: string | undefined) => (id ? (productsById.get(id)?.name ?? 'Removed product') : '');
  const cylindersText = (account: BorrowerAccount) =>
    Array.from(account.cylinders, ([id, qty]) => `${qty} × ${productName(id)}`).join(', ');
  const details = (entry: LoanEntry): string => {
    const cylinders = entry.qty ? `${Math.abs(entry.qty)} × ${productName(entry.productId)}` : '';
    switch (entry.kind) {
      case 'credit': {
        const sale = entry.saleId ? salesById.get(entry.saleId) : undefined;
        return sale ? `${sale.receiptNo} · ${sale.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}` : '';
      }
      case 'payment':
        return entry.payment ? `${PAYMENT_LABELS[entry.payment.method]}${entry.payment.reference ? ` · ${entry.payment.reference}` : ''}` : '';
      case 'void':
        return [cylinders, entry.note].filter(Boolean).join(' · ');
      default:
        return cylinders;
    }
  };
  const userName = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  return { borrowers, loans, accounts, products, productsById, salesById, productName, cylindersText, details, userName };
}

/** Refills on credit, cylinders lent with a refill, returns and payments. */
export function BorrowingScreen() {
  const data = useBorrowingData();
  const { accounts } = data;
  const [show, setShow] = useState<'open' | 'all' | 'history'>('open');
  const [lending, setLending] = useState<LendInput['kind'] | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<Borrower | null>(null);
  const [receipt, setReceipt] = useState<Sale | null>(null);

  const open = accounts.filter((a) => a.owed !== 0 || a.cylindersOut > 0);
  const owing = accounts.filter((a) => a.owed > 0);
  const withCylinders = accounts.filter((a) => a.cylindersOut > 0);
  const totalOwed = owing.reduce((sum, a) => sum + a.owed, 0);
  const cylindersOut = withCylinders.reduce((sum, a) => sum + a.cylindersOut, 0);
  const oldest = open.find((a) => a.openSince);
  const viewed = accounts.find((a) => a.borrower.id === viewing) ?? null;
  const ANY = '';

  const accountColumns: Column<BorrowerAccount>[] = [
    {
      key: 'name',
      title: 'Borrower',
      flex: 1.4,
      text: (a) => `${a.borrower.name} ${a.borrower.phone ?? ''}`,
      sortValue: (a) => a.borrower.name,
      render: (a) => (
        <View style={styles.cellText}>
          <Text weight="600" numberOfLines={1}>
            {a.borrower.name}
          </Text>
          {a.borrower.phone ? (
            <Text variant="small" muted numberOfLines={1}>
              {a.borrower.phone}
            </Text>
          ) : null}
        </View>
      ),
    },
    { key: 'owed', title: 'Owes', width: 140, align: 'right', text: (a) => owedText(a.owed), sortValue: (a) => a.owed },
    // All types together; the account shows each type.
    {
      key: 'cylinders',
      title: 'Cylinders out',
      width: 140,
      align: 'right',
      text: (a) => (a.cylindersOut > 0 ? String(a.cylindersOut) : '—'),
      sortValue: (a) => a.cylindersOut,
    },
    {
      key: 'since',
      title: 'Borrowed since',
      width: 190,
      text: (a) => (a.openSince ? sinceText(a.openSince) : '—'),
      sortValue: (a) => a.openSince ?? '9999',
    },
    {
      key: 'last',
      title: 'Last activity',
      width: 190,
      text: (a) => (a.lastActivity ? formatDateTime(a.lastActivity) : '—'),
      sortValue: (a) => a.lastActivity ?? '',
    },
  ];

  const historyColumns: Column<LoanEntry>[] = [
    { key: 'when', title: 'When', width: 180, text: (e) => formatDateTime(e.occurredAt), sortValue: (e) => e.occurredAt },
    { key: 'name', title: 'Borrower', flex: 1.2, text: (e) => e.borrowerName },
    { key: 'kind', title: 'What', width: 150, text: (e) => LOAN_LABELS[e.kind] },
    { key: 'details', title: 'Details', flex: 2, text: (e) => data.details(e) },
    { key: 'amount', title: 'Amount', width: 120, align: 'right', text: (e) => signedPeso(e.amount), sortValue: (e) => e.amount },
    { key: 'by', title: 'By', flex: 1, text: (e) => data.userName(e.userId) },
  ];
  const history = [...data.loans].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Borrowing"
        subtitle="Refills on credit, borrowed cylinders, returns and payments at every branch."
        actions={
          <>
            <Button title="Refill on credit" icon="time-outline" onPress={() => setLending('credit')} />
            <Button title="Lend cylinder" icon="arrow-up-circle-outline" onPress={() => setLending('cylinder')} />
            <Button title="Return cylinder" icon="arrow-down-circle-outline" variant="secondary" onPress={() => setReturning(ANY)} />
            <Button title="Record payment" icon="wallet-outline" variant="secondary" onPress={() => setPaying(ANY)} />
          </>
        }
      />
      <View style={styles.tiles}>
        <StatTile label="Owed to the store" value={formatPeso(totalOwed)} hint={`${owing.length} borrower${owing.length === 1 ? '' : 's'}`} icon="wallet-outline" />
        <StatTile
          label="Cylinders out"
          value={String(cylindersOut)}
          hint={`${withCylinders.length} borrower${withCylinders.length === 1 ? '' : 's'}`}
          icon="flame-outline"
        />
        <StatTile
          label="Open the longest"
          value={oldest?.openSince ? formatDay(localDay(oldest.openSince)) : '—'}
          hint={oldest ? oldest.borrower.name : 'Nothing is open'}
          icon="hourglass-outline"
          tone={oldest?.openSince && daysAgo(oldest.openSince) > 30 ? 'warning' : 'neutral'}
        />
      </View>
      <Card padded>
        <SegmentedControl
          accessibilityLabel="Show"
          options={[
            { label: `Open (${open.length})`, value: 'open' },
            { label: `All (${accounts.length})`, value: 'all' },
            { label: 'History', value: 'history' },
          ]}
          value={show}
          onChange={setShow}
        />
        {show === 'history' ? (
          <DataTable
            rows={history}
            columns={historyColumns}
            rowKey={(e) => e.id}
            searchPlaceholder="Search history"
            emptyText="Nothing borrowed yet."
            minWidth={980}
          />
        ) : (
          <DataTable
            rows={show === 'open' ? open : accounts}
            columns={accountColumns}
            rowKey={(a) => a.borrower.id}
            onRowPress={(a) => setViewing(a.borrower.id)}
            searchPlaceholder="Search borrowers"
            emptyText={show === 'open' ? 'Nobody owes anything or has a cylinder out.' : 'No borrowers yet.'}
            minWidth={830}
          />
        )}
      </Card>

      <LendDialog
        kind={lending}
        onClose={() => setLending(null)}
        onDone={(sale) => {
          setLending(null);
          setReceipt(sale);
        }}
      />
      <ReturnDialog borrowerId={returning} onClose={() => setReturning(null)} />
      <PayDialog borrowerId={paying} onClose={() => setPaying(null)} />
      <AccountDialog
        account={viewed}
        onClose={() => setViewing(null)}
        onPay={(id) => {
          setViewing(null);
          setPaying(id);
        }}
        onReturn={(id) => {
          setViewing(null);
          setReturning(id);
        }}
        onEdit={(borrower) => {
          setViewing(null);
          setEditing(borrower);
        }}
      />
      <EditBorrowerDialog borrower={editing} onClose={() => setEditing(null)} />
      <ReceiptDialog sale={receipt} onClose={() => setReceipt(null)} />
    </ScrollView>
  );
}

type LendForm = z.input<typeof lendFormSchema>;

const blankLend = (kind: LendInput['kind'] | null): LendForm => ({
  borrowerId: '',
  newName: '',
  newPhone: '',
  productId: '',
  qty: '1',
  paidNow: kind === 'cylinder',
});

function LendDialog({ kind, onClose, onDone }: { kind: LendInput['kind'] | null; onClose: () => void; onDone: (sale: Sale) => void }) {
  const work = useWork();
  const { colors } = useTheme();
  const { accounts, products, cylindersText } = useBorrowingData();
  const { data: movements } = useCollection<StockMovement>('movements');
  const form = useZodForm(lendFormSchema, blankLend(kind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ input: LendInput; total: Centavos } | null>(null);
  const { reset } = form;

  useEffect(() => {
    setPayment(null);
    if (kind) {
      reset(blankLend(kind));
      setError(null);
    }
  }, [kind, reset]);

  const v = form.values;
  const levels = stockByProduct(movements, work.locationId);
  const product = products.find((p) => p.id === v.productId);
  const qty = parseInt(v.qty, 10) || 0;
  const total = product && kind ? lendLine(kind, product, qty).total : 0;
  const account = accounts.find((a) => a.borrower.id === v.borrowerId);
  const who = v.borrowerId === NEW_BORROWER ? v.newName.trim() || 'the new borrower' : (account?.borrower.name ?? 'the borrower');
  const Who = who.charAt(0).toUpperCase() + who.slice(1);

  const record = async (input: LendInput) => {
    const sale = await lend(work.ctx, input);
    setPayment(null);
    onDone(sale);
  };

  const submit = form.handleSubmit(async (values) => {
    if (!kind) return;
    const input: LendInput = {
      kind,
      borrower: values.borrowerId === NEW_BORROWER ? { name: values.newName, phone: values.newPhone } : { id: values.borrowerId, name: '' },
      productId: values.productId,
      qty: values.qty,
      payment: null,
    };
    if (kind === 'cylinder' && values.paidNow) {
      setPayment({ input, total });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await record(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  const borrowerOptions = [
    { label: 'New borrower…', value: NEW_BORROWER, hint: 'Add someone who is not on the list yet' },
    ...[...accounts]
      .sort((a, b) => a.borrower.name.localeCompare(b.borrower.name))
      .map((a) => ({
        label: a.borrower.name,
        value: a.borrower.id,
        hint: [a.owed > 0 ? `owes ${formatPeso(a.owed)}` : '', a.cylindersOut > 0 ? `has ${cylindersText(a)}` : '', a.borrower.phone ?? '']
          .filter(Boolean)
          .join(' · ') || undefined,
      })),
  ];
  const cylinderOptions = products
    .filter((p) => p.active && p.kind === 'cylinder')
    .map((p) => ({
      label: p.name,
      value: p.id,
      hint: `${levelOf(levels, p.id).full} full here · refill ${formatPeso(p.refillPrice ?? p.price)}`,
    }));

  const title = kind === 'cylinder' ? 'Lend a cylinder' : 'Refill on credit';
  const cylinders = product ? `${qty} full ${product.name} ${qty === 1 ? 'cylinder' : 'cylinders'}` : '';
  const summary =
    !product || qty < 1
      ? 'Choose who is borrowing, the cylinder and how many.'
      : kind === 'cylinder'
        ? `${Who} takes ${cylinders} without giving an empty, and brings ${qty === 1 ? 'it' : 'them'} back later. The refill is ${formatPeso(total)}, ${v.paidNow ? 'paid now' : `added to what ${who} owes`}.`
        : `${Who} swaps ${qty} empty for ${cylinders} now and pays ${formatPeso(total)} later. It is recorded as borrowed today, ${formatDay(localDay(new Date()))}.`;

  return (
    <>
      <Dialog
        visible={!!kind && !payment}
        title={title}
        onClose={onClose}
        dismissable={!busy}
        width={560}
        actions={
          <>
            <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            <Button
              title={kind === 'credit' ? 'Put on account' : v.paidNow ? 'Continue to payment' : 'Lend cylinder'}
              icon="checkmark"
              onPress={submit}
              loading={busy}
            />
          </>
        }
      >
        <Select
          label="Borrower"
          value={v.borrowerId}
          options={borrowerOptions}
          onChange={(id) => form.set('borrowerId', id)}
          error={form.errors.borrowerId}
          placeholder="Choose who is borrowing…"
        />
        {v.borrowerId === NEW_BORROWER ? (
          <View style={styles.pair}>
            <TextField
              label="Name"
              value={v.newName}
              onChangeText={(text) => form.set('newName', text)}
              error={form.errors.newName}
              containerStyle={styles.half}
              autoFocus
            />
            <TextField
              label="Phone (optional)"
              value={v.newPhone}
              onChangeText={(text) => form.set('newPhone', text)}
              error={form.errors.newPhone}
              keyboardType="phone-pad"
              containerStyle={styles.half}
            />
          </View>
        ) : null}
        <View style={styles.pair}>
          <View style={styles.half}>
            <Select
              label="Cylinder"
              value={v.productId}
              options={cylinderOptions}
              onChange={(id) => form.set('productId', id)}
              error={form.errors.productId}
            />
          </View>
          <TextField
            label="Quantity"
            value={v.qty}
            onChangeText={(text) => form.set('qty', text.replace(/\D/g, ''))}
            error={form.errors.qty}
            keyboardType="number-pad"
            containerStyle={styles.qty}
          />
        </View>
        {kind === 'cylinder' ? (
          <View style={styles.field}>
            <Text variant="label">The refill</Text>
            <SegmentedControl
              options={[
                { label: 'Paid now', value: 'now' },
                { label: 'Put on their account', value: 'later' },
              ]}
              value={v.paidNow ? 'now' : 'later'}
              onChange={(value) => form.set('paidNow', value === 'now')}
            />
          </View>
        ) : null}
        <View style={[styles.summary, { backgroundColor: colors.primarySoft }]}>
          <Text>{summary}</Text>
        </View>
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </Dialog>
      <PaymentDialog
        visible={!!payment}
        total={payment?.total ?? 0}
        title="Refill payment"
        confirmLabel="Lend cylinder"
        cancelLabel="Back"
        onCancel={() => setPayment(null)}
        onConfirm={async (paid: Payment) => {
          if (payment) await record({ ...payment.input, payment: paid });
        }}
      />
    </>
  );
}

type ReturnForm = z.input<typeof cylinderReturnFormSchema>;

function ReturnDialog({ borrowerId, onClose }: { borrowerId: string | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { accounts, productName } = useBorrowingData();
  const blank = (id: string): ReturnForm => ({ borrowerId: id, productId: '', qty: '1' });
  const form = useZodForm(cylinderReturnFormSchema, blank(''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reset, set } = form;
  const withCylinders = accounts.filter((a) => a.cylindersOut > 0);
  const account = withCylinders.find((a) => a.borrower.id === form.values.borrowerId);
  const theirs = account ? Array.from(account.cylinders.keys()) : [];

  useEffect(() => {
    if (borrowerId !== null) {
      reset(blank(borrowerId));
      setError(null);
    }
  }, [borrowerId, reset]);

  // With only one kind of cylinder out, pick it.
  const onlyProduct = theirs.length === 1 ? theirs[0] : undefined;
  useEffect(() => {
    if (onlyProduct) set('productId', onlyProduct);
  }, [onlyProduct, set]);

  const submit = form.handleSubmit(async (input) => {
    setBusy(true);
    setError(null);
    try {
      await returnCylinder(work.ctx, input);
      toast.show(`${account?.borrower.name ?? 'The borrower'} returned ${input.qty} × ${productName(input.productId)}. It is on the shelf as empty.`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  const since = (productId: string) => account?.openCylinders.find((c) => c.productId === productId)?.entry.occurredAt;

  return (
    <Dialog
      visible={borrowerId !== null}
      title="Return a borrowed cylinder"
      onClose={onClose}
      dismissable={!busy}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Record return" icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      {withCylinders.length === 0 ? (
        <EmptyState icon="checkmark-circle-outline" title="No cylinders are out" message="Every borrowed cylinder has come back." />
      ) : (
        <>
          <Select
            label="Borrower"
            value={form.values.borrowerId}
            options={withCylinders.map((a) => ({ label: a.borrower.name, value: a.borrower.id, hint: `${a.cylindersOut} cylinder${a.cylindersOut === 1 ? '' : 's'} out` }))}
            onChange={(id) => {
              set('borrowerId', id);
              set('productId', '');
            }}
            error={form.errors.borrowerId}
          />
          <View style={styles.pair}>
            <View style={styles.half}>
              <Select
                label="Cylinder"
                value={form.values.productId}
                options={theirs.map((id) => {
                  const when = since(id);
                  return { label: productName(id), value: id, hint: `${account?.cylinders.get(id) ?? 0} out${when ? ` since ${sinceText(when)}` : ''}` };
                })}
                onChange={(id) => set('productId', id)}
                error={form.errors.productId}
                disabled={!account}
              />
            </View>
            <TextField
              label="Quantity"
              value={form.values.qty}
              onChangeText={(text) => set('qty', text.replace(/\D/g, ''))}
              error={form.errors.qty}
              keyboardType="number-pad"
              containerStyle={styles.qty}
            />
          </View>
          <Text muted>The cylinder goes back on the shelf at {work.location?.name ?? 'this branch'} as an empty.</Text>
        </>
      )}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

function PayDialog({ borrowerId, onClose }: { borrowerId: string | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { accounts } = useBorrowingData();
  const owing = accounts.filter((a) => a.owed > 0);
  const owedBy = useMemo(() => {
    const owed = new Map(accounts.map((a) => [a.borrower.id, a.owed]));
    return (id: string) => owed.get(id) ?? 0;
  }, [accounts]);
  const schema = useMemo(() => loanPaymentFormSchema(owedBy), [owedBy]);
  const form = useZodForm(schema, { borrowerId: '', amount: '' });
  const [paying, setPaying] = useState<{ borrowerId: string; amount: Centavos } | null>(null);
  const { reset, set } = form;
  const account = owing.find((a) => a.borrower.id === form.values.borrowerId);

  const amountFor = (id: string) => {
    const owed = owedBy(id);
    return owed > 0 ? (owed % 100 === 0 ? String(owed / 100) : (owed / 100).toFixed(2)) : '';
  };

  // Only opening the dialog fills in the amount, so a balance that changes while it is open doesn't overwrite what was typed.
  useEffect(() => {
    setPaying(null);
    if (borrowerId !== null) reset({ borrowerId, amount: borrowerId ? amountFor(borrowerId) : '' });
  }, [borrowerId, reset]);

  const submit = form.handleSubmit((input) => setPaying(input));

  return (
    <>
      <Dialog
        visible={borrowerId !== null && !paying}
        title="Record a payment"
        onClose={onClose}
        actions={
          <>
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button title="Continue to payment" icon="arrow-forward" onPress={submit} disabled={owing.length === 0} />
          </>
        }
      >
        {owing.length === 0 ? (
          <EmptyState icon="checkmark-circle-outline" title="Nobody owes anything" />
        ) : (
          <>
            <Select
              label="Who is paying"
              value={form.values.borrowerId}
              options={owing.map((a) => ({ label: a.borrower.name, value: a.borrower.id, hint: `owes ${formatPeso(a.owed)}` }))}
              onChange={(id) => {
                set('borrowerId', id);
                set('amount', amountFor(id));
              }}
              error={form.errors.borrowerId}
            />
            <TextField
              label="Amount"
              prefix="₱"
              value={form.values.amount}
              onChangeText={(text) => set('amount', text)}
              error={form.errors.amount}
              hint={account ? `Owes ${formatPeso(account.owed)}. A part payment is fine; the oldest refill is paid first.` : undefined}
              keyboardType="decimal-pad"
            />
          </>
        )}
      </Dialog>
      <PaymentDialog
        visible={!!paying}
        total={paying?.amount ?? 0}
        title={`Payment from ${accounts.find((a) => a.borrower.id === paying?.borrowerId)?.borrower.name ?? ''}`}
        confirmLabel="Record payment"
        cancelLabel="Back"
        onCancel={() => setPaying(null)}
        onConfirm={async (payment) => {
          if (!paying) return;
          await payLoan(work.ctx, { borrowerId: paying.borrowerId, payment });
          const left = owedBy(paying.borrowerId) - payment.amount;
          const name = accounts.find((a) => a.borrower.id === paying.borrowerId)?.borrower.name ?? 'The borrower';
          toast.show(left > 0 ? `Payment recorded. ${name} still owes ${formatPeso(left)}.` : `Payment recorded. ${name} is fully paid.`, 'success');
          setPaying(null);
          onClose();
        }}
      />
    </>
  );
}

function AccountDialog({
  account,
  onClose,
  onPay,
  onReturn,
  onEdit,
}: {
  account: BorrowerAccount | null;
  onClose: () => void;
  onPay: (borrowerId: string) => void;
  onReturn: (borrowerId: string) => void;
  onEdit: (borrower: Borrower) => void;
}) {
  const { colors } = useTheme();
  const { salesById, productName, cylindersText, details } = useBorrowingData();
  if (!account) return <Dialog visible={false} title="" onClose={onClose}>{null}</Dialog>;
  const { borrower } = account;
  const recent = [...account.entries].reverse().slice(0, 15);

  return (
    <Dialog
      visible
      title={borrower.name}
      onClose={onClose}
      width={620}
      actions={
        <>
          <Button title="Edit name or phone" variant="ghost" onPress={() => onEdit(borrower)} />
          {account.cylindersOut > 0 ? <Button title="Return cylinder" variant="secondary" onPress={() => onReturn(borrower.id)} /> : null}
          {account.owed > 0 ? <Button title="Record payment" onPress={() => onPay(borrower.id)} /> : null}
        </>
      }
    >
      <View style={styles.tiles}>
        <StatTile label="Owes" value={owedText(account.owed)} icon="wallet-outline" tone={account.owed > 0 ? 'warning' : 'success'} />
        <StatTile label="Cylinders out" value={String(account.cylindersOut)} hint={cylindersText(account) || undefined} icon="flame-outline" />
      </View>
      {borrower.phone ? <Text muted>Phone: {borrower.phone}</Text> : null}

      <Text variant="label">Still open</Text>
      {account.openCredits.length === 0 && account.openCylinders.length === 0 ? (
        <Text muted>Nothing. All refills are paid and all cylinders are back.</Text>
      ) : (
        <View style={[styles.list, { borderColor: colors.border }]}>
          {account.openCredits.map(({ entry, left }) => (
            <View key={entry.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
              <Text style={styles.when}>{sinceText(entry.occurredAt)}</Text>
              <Text style={styles.flex}>
                Refill on account{entry.saleId && salesById.get(entry.saleId) ? ` · ${salesById.get(entry.saleId)!.receiptNo}` : ''}
              </Text>
              <Badge label={left === entry.amount ? `${formatPeso(left)} unpaid` : `${formatPeso(left)} of ${formatPeso(entry.amount)} left`} tone="warning" />
            </View>
          ))}
          {account.openCylinders.map(({ entry, productId, left }) => (
            <View key={entry.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
              <Text style={styles.when}>{sinceText(entry.occurredAt)}</Text>
              <Text style={styles.flex}>Borrowed {productName(productId)}</Text>
              <Badge label={`${left} still out`} tone="info" />
            </View>
          ))}
        </View>
      )}

      <Text variant="label">History</Text>
      <View style={[styles.list, { borderColor: colors.border }]}>
        {recent.map((entry) => (
          <View key={entry.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
            <Text style={styles.when} muted>
              {formatDateTime(entry.occurredAt)}
            </Text>
            <View style={styles.flex}>
              <Text>{LOAN_LABELS[entry.kind]}</Text>
              {details(entry) ? (
                <Text variant="small" muted>
                  {details(entry)}
                </Text>
              ) : null}
            </View>
            <Text numeric>{signedPeso(entry.amount)}</Text>
          </View>
        ))}
      </View>
    </Dialog>
  );
}

function EditBorrowerDialog({ borrower, onClose }: { borrower: Borrower | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (borrower) {
      setName(borrower.name);
      setPhone(borrower.phone ?? '');
      setError(null);
    }
  }, [borrower]);

  const save = async () => {
    if (!borrower) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveBorrower(work.ctx, { id: borrower.id, name, phone });
      toast.show(`${saved.name} saved.`, 'success');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={!!borrower}
      title="Edit borrower"
      onClose={onClose}
      dismissable={!busy}
      width={460}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Save" icon="checkmark" onPress={save} loading={busy} />
        </>
      }
    >
      <TextField label="Name" value={name} onChangeText={setName} autoFocus />
      <TextField label="Phone (optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Text variant="small" muted>
        Past receipts and history keep the name used at the time.
      </Text>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  field: { gap: spacing.xs },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'flex-start' },
  half: { flexGrow: 1, flexBasis: 200 },
  qty: { width: 110 },
  summary: { borderRadius: radius.md, padding: spacing.md },
  list: { borderWidth: 1, borderRadius: radius.md, overflow: 'hidden' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  when: { width: 170 },
  flex: { flex: 1 },
  /** Fills the table cell, so long text is cut short instead of running into the next column. */
  cellText: { alignSelf: 'stretch' },
});

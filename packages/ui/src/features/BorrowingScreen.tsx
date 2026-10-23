import {
  borrowerAccounts,
  borrowersOnly,
  cheques,
  cylinderReturnFormSchema,
  daysAgo,
  downPaymentSchema,
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
  PAYMENT_METHODS,
  payLoan,
  priceCart,
  returnCylinder,
  saveBorrower,
  sellOnCredit,
  settleCheque,
  stockByProduct,
  worksAt,
  type Borrower,
  type BorrowerAccount,
  type CartLine,
  type Centavos,
  type ChequeInfo,
  type Customer,
  type CustomerRef,
  type LendInput,
  type LoanEntry,
  type Payment,
  type Product,
  type ProductSet,
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
import { CustomerField, CustomerPickerDialog } from './CustomerPicker';
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

const chequeText = (entry: LoanEntry) => {
  const cheque = entry.payment?.cheque;
  return cheque ? `${cheque.bank} cheque no. ${cheque.number}, cash on ${formatDay(cheque.cashOn)}` : '';
};

/** Lookups shared by the screen and its dialogs. */
function useBorrowingData() {
  const { data: customers } = useCollection<Customer>('borrowers');
  const { data: loans } = useCollection<LoanEntry>('loans');
  const { data: products } = useCollection<Product>('products');
  const { data: sales } = useCollection<Sale>('sales');
  const { data: users } = useCollection<User>('users');
  // Customers are named on any sale; the Borrowing window lists only those who have borrowed.
  const borrowers = useMemo(() => borrowersOnly(customers, loans), [customers, loans]);
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
        if (entry.payment?.method === 'cheque') return chequeText(entry);
        return entry.payment ? `${PAYMENT_LABELS[entry.payment.method]}${entry.payment.reference ? ` · ${entry.payment.reference}` : ''}` : '';
      case 'cheque_cleared':
      case 'cheque_bounced':
        return entry.note ?? '';
      case 'void':
        return [cylinders, entry.note].filter(Boolean).join(' · ');
      default:
        return cylinders;
    }
  };
  const userName = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  return { customers, borrowers, loans, accounts, products, productsById, salesById, productName, cylindersText, details, userName };
}

type Show = 'open' | 'all' | 'cheques' | 'history';

const CHEQUE_STATE: Record<ChequeInfo['state'], { label: string; tone: 'info' | 'success' | 'danger' }> = {
  waiting: { label: 'Not yet deposited', tone: 'info' },
  cleared: { label: 'Cleared', tone: 'success' },
  bounced: { label: 'Bounced', tone: 'danger' },
};

/** Anything sold on credit, cylinders lent with a refill, returns, payments and post-dated cheques. */
export function BorrowingScreen({ initialShow = 'open' }: { initialShow?: Show } = {}) {
  const work = useWork();
  const data = useBorrowingData();
  const { accounts } = data;
  const [show, setShow] = useState<Show>(initialShow);
  const [lending, setLending] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [settling, setSettling] = useState<ChequeInfo | null>(null);
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
  const today = localDay(new Date());
  const allCheques = cheques(data.loans);
  const chequesDue = allCheques.filter((c) => c.state === 'waiting' && c.cheque.cashOn <= today);
  const canSettle = work.can('cheques.manage');

  useEffect(() => setShow(initialShow), [initialShow]);

  const chequeColumns: Column<ChequeInfo>[] = [
    { key: 'cashOn', title: 'Cash on', width: 130, text: (c) => formatDay(c.cheque.cashOn), sortValue: (c) => c.cheque.cashOn },
    { key: 'name', title: 'From', flex: 1.2, text: (c) => c.entry.borrowerName },
    { key: 'cheque', title: 'Cheque', flex: 1.4, text: (c) => `${c.cheque.bank} no. ${c.cheque.number}` },
    { key: 'amount', title: 'Amount', width: 120, align: 'right', text: (c) => formatPeso(c.amount), sortValue: (c) => c.amount },
    { key: 'received', title: 'Received', width: 170, text: (c) => formatDateTime(c.entry.occurredAt), sortValue: (c) => c.entry.occurredAt },
    {
      key: 'state',
      title: 'Status',
      width: 170,
      sortValue: (c) => (c.state === 'waiting' ? (c.cheque.cashOn <= today ? 0 : 1) : 2),
      render: (c) =>
        c.state === 'waiting' && c.cheque.cashOn <= today ? (
          <Badge label="Can be cashed now" tone="warning" icon="alert-circle-outline" />
        ) : (
          <Badge label={CHEQUE_STATE[c.state].label} tone={CHEQUE_STATE[c.state].tone} />
        ),
    },
  ];

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
        subtitle="Sales on credit, borrowed cylinders, returns, payments and post-dated cheques at every branch."
        actions={
          <>
            <Button title="Sales on credit" icon="time-outline" onPress={() => setCrediting(true)} />
            <Button title="Lend cylinder" icon="arrow-up-circle-outline" onPress={() => setLending(true)} />
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
        {allCheques.some((c) => c.state === 'waiting') ? (
          <StatTile
            label="Post-dated cheques"
            value={formatPeso(allCheques.filter((c) => c.state === 'waiting').reduce((sum, c) => sum + c.amount, 0))}
            hint={chequesDue.length > 0 ? `${chequesDue.length} can be cashed now` : 'None can be cashed yet'}
            icon="document-text-outline"
            tone={chequesDue.length > 0 ? 'warning' : 'neutral'}
          />
        ) : null}
      </View>
      <Card padded>
        <SegmentedControl
          accessibilityLabel="Show"
          options={[
            { label: `Open (${open.length})`, value: 'open' },
            { label: `All (${accounts.length})`, value: 'all' },
            { label: `Cheques (${allCheques.length})`, value: 'cheques' },
            { label: 'History', value: 'history' },
          ]}
          value={show}
          onChange={setShow}
        />
        {show === 'cheques' ? (
          <>
            <DataTable
              rows={allCheques}
              columns={chequeColumns}
              rowKey={(c) => c.entry.id}
              onRowPress={canSettle ? (c) => c.state === 'waiting' && worksAt(work.user, c.entry.locationId) && setSettling(c) : undefined}
              searchPlaceholder="Search cheques"
              emptyText="No post-dated cheques yet. Take one with Record payment."
              initialSort={{ key: 'state', direction: 'asc' }}
              minWidth={900}
            />
            <Text variant="small" muted>
              {canSettle
                ? 'A cheque counts as paid when it is taken. Click a cheque once it is deposited to mark it cleared, or bounced: a bounced cheque is owed again.'
                : 'A cheque counts as paid when it is taken. The owner, an admin or the branch manager marks it cleared or bounced once it is deposited.'}
            </Text>
          </>
        ) : show === 'history' ? (
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
        visible={lending}
        onClose={() => setLending(false)}
        onDone={(sale) => {
          setLending(false);
          setReceipt(sale);
        }}
      />
      <CreditDialog
        visible={crediting}
        onClose={() => setCrediting(false)}
        onDone={(sale) => {
          setCrediting(false);
          setReceipt(sale);
        }}
      />
      <SettleChequeDialog cheque={settling} onClose={() => setSettling(null)} />
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

const blankLend = (): LendForm => ({
  borrowerId: '',
  newName: '',
  newPhone: '',
  productId: '',
  qty: '1',
  paidNow: true,
});

/** Everyone who can borrow: customers on the list, with what they owe and have out. */
function borrowerOptions(customers: Customer[], accounts: BorrowerAccount[], cylindersText: (a: BorrowerAccount) => string) {
  return [
    { label: 'New customer…', value: NEW_BORROWER, hint: 'Add someone who is not on the list yet' },
    ...[...customers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const a = accounts.find((x) => x.borrower.id === c.id);
        return {
          label: c.name,
          value: c.id,
          hint:
            [a && a.owed > 0 ? `owes ${formatPeso(a.owed)}` : '', a && a.cylindersOut > 0 ? `has ${cylindersText(a)}` : '', c.phone ?? '']
              .filter(Boolean)
              .join(' · ') || undefined,
        };
      }),
  ];
}

function LendDialog({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: (sale: Sale) => void }) {
  const work = useWork();
  const { colors } = useTheme();
  const { customers, accounts, products, cylindersText } = useBorrowingData();
  const { data: movements } = useCollection<StockMovement>('movements');
  const form = useZodForm(lendFormSchema, blankLend());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ input: LendInput; total: Centavos } | null>(null);
  const { reset } = form;

  useEffect(() => {
    setPayment(null);
    if (visible) {
      reset(blankLend());
      setError(null);
    }
  }, [visible, reset]);

  const v = form.values;
  const levels = stockByProduct(movements, work.locationId);
  const product = products.find((p) => p.id === v.productId);
  const qty = parseInt(v.qty, 10) || 0;
  const customer = customers.find((c) => c.id === v.borrowerId);
  const total = product ? lendLine(product, qty, customer).total : 0;
  const who = v.borrowerId === NEW_BORROWER ? v.newName.trim() || 'the new borrower' : (customer?.name ?? 'the borrower');
  const Who = who.charAt(0).toUpperCase() + who.slice(1);

  const record = async (input: LendInput) => {
    const sale = await lend(work.ctx, input);
    setPayment(null);
    onDone(sale);
  };

  const submit = form.handleSubmit(async (values) => {
    const input: LendInput = {
      borrower: values.borrowerId === NEW_BORROWER ? { name: values.newName, phone: values.newPhone } : { id: values.borrowerId, name: '' },
      productId: values.productId,
      qty: values.qty,
      payment: null,
    };
    if (values.paidNow) {
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

  const cylinderOptions = products
    .filter((p) => p.active && p.kind === 'cylinder')
    .map((p) => ({
      label: p.name,
      value: p.id,
      hint: `${levelOf(levels, p.id).full} full here · refill ${formatPeso(p.refillPrice ?? p.price)}`,
    }));

  const cylinders = product ? `${qty} full ${product.name} ${qty === 1 ? 'cylinder' : 'cylinders'}` : '';
  const summary =
    !product || qty < 1
      ? 'Choose who is borrowing, the cylinder and how many.'
      : `${Who} takes ${cylinders} without giving an empty, and brings ${qty === 1 ? 'it' : 'them'} back later. The refill is ${formatPeso(total)}, ${v.paidNow ? 'paid now' : `added to what ${who} owes`}.`;

  return (
    <>
      <Dialog
        visible={visible && !payment}
        title="Lend a cylinder"
        onClose={onClose}
        dismissable={!busy}
        width={560}
        actions={
          <>
            <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            <Button
              title={v.paidNow ? 'Continue to payment' : 'Lend cylinder'}
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
          options={borrowerOptions(customers, accounts, cylindersText)}
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

interface CreditRow {
  /** A product id, or "set:<id>". */
  pick: string;
  type: 'refill' | 'new' | 'item';
  qty: string;
}

const blankRow = (): CreditRow => ({ pick: '', type: 'refill', qty: '1' });

const NOTHING_PAID = { amount: '', method: 'cash' as const, reference: '' };

/**
 * Sales on credit: anything in the store on the customer's account, refills,
 * new cylinders, accessories or sets. They can pay part of it now; later
 * payments go through Record payment.
 */
function CreditDialog({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: (sale: Sale) => void }) {
  const work = useWork();
  const { colors } = useTheme();
  const { customers, products, productsById } = useBorrowingData();
  const { data: sets } = useCollection<ProductSet>('sets');
  const [customer, setCustomer] = useState<CustomerRef | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [rows, setRows] = useState<CreditRow[]>([blankRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setsById = new Map(sets.map((s) => [s.id, s]));
  const toLine = (row: CreditRow): CartLine | null => {
    const qty = parseInt(row.qty, 10);
    if (!row.pick || !(qty > 0)) return null;
    if (row.pick.startsWith('set:')) return setsById.has(row.pick.slice(4)) ? { type: 'set', setId: row.pick.slice(4), qty } : null;
    const product = productsById.get(row.pick);
    if (!product) return null;
    return { type: product.kind === 'accessory' ? 'item' : row.type === 'new' ? 'new' : 'refill', productId: product.id, qty };
  };
  const rowLines = rows.map(toLine);
  const cart = rowLines.filter((line): line is CartLine => line !== null);
  const record = customer?.id ? customers.find((c) => c.id === customer.id) : null;
  const { lines, total } = priceCart(cart, productsById, setsById, record);
  /** The priced line for a row, if the row is complete. */
  const lineFor = (index: number) => (rowLines[index] ? lines[rowLines.slice(0, index).filter(Boolean).length] : undefined);
  const change = (index: number, patch: Partial<CreditRow>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const paySchema = useMemo(() => downPaymentSchema(total), [total]);
  const pay = useZodForm(paySchema, NOTHING_PAID);
  const { reset: resetPay } = pay;
  const checked = paySchema.safeParse(pay.values);
  const paidNow = checked.success ? checked.data : null;
  const later = total - (paidNow?.amount ?? 0);

  useEffect(() => {
    if (visible) {
      setCustomer(null);
      setRows([blankRow()]);
      resetPay(NOTHING_PAID);
      setError(null);
    }
  }, [visible, resetPay]);

  const options = [
    ...products.filter((p) => p.active).map((p) => ({
      label: p.name,
      value: p.id,
      hint: p.kind === 'cylinder' ? `Refill ${formatPeso(p.refillPrice ?? p.price)} · New ${formatPeso(p.price)}` : formatPeso(p.price),
    })),
    ...sets.filter((s) => s.active).map((s) => ({ label: `${s.name} (set)`, value: `set:${s.id}`, hint: formatPeso(s.price) })),
  ];

  const submit = pay.handleSubmit(async (downPayment) => {
    if (!customer) return setError('Choose who is buying on credit.');
    if (cart.length === 0) return setError('Add what they are taking.');
    setBusy(true);
    setError(null);
    try {
      onDone(await sellOnCredit(work.ctx, { borrower: customer, cart, downPayment }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <>
      <Dialog
        visible={visible && !choosing}
        title="Sales on credit"
        onClose={onClose}
        dismissable={!busy}
        width={640}
        actions={
          <>
            <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            <Button title={`Put ${formatPeso(later)} on account`} icon="checkmark" onPress={submit} loading={busy} disabled={cart.length === 0} />
          </>
        }
      >
        <CustomerField customer={customer} onChoose={() => setChoosing(true)} required />
        <View style={styles.field}>
          <Text variant="label">What they take</Text>
          {rows.map((row, index) => {
            const product = productsById.get(row.pick);
            const line = lineFor(index);
            return (
              <View key={index} style={[styles.itemRow, { borderColor: colors.border }]}>
                <View style={styles.half}>
                  <Select value={row.pick} options={options} placeholder="Choose a product or set…" onChange={(pick) => change(index, { pick })} />
                </View>
                {product?.kind === 'cylinder' ? (
                  <SegmentedControl
                    size="sm"
                    accessibilityLabel="Refill or new"
                    options={[
                      { label: 'Refill', value: 'refill' },
                      { label: 'New', value: 'new' },
                    ]}
                    value={row.type === 'new' ? 'new' : 'refill'}
                    onChange={(type) => change(index, { type })}
                  />
                ) : null}
                <TextField
                  value={row.qty}
                  onChangeText={(qty) => change(index, { qty: qty.replace(/\D/g, '') })}
                  keyboardType="number-pad"
                  accessibilityLabel="Quantity"
                  containerStyle={styles.smallQty}
                />
                <Button title="Remove" variant="ghost" size="sm" onPress={() => setRows(rows.filter((_, i) => i !== index))} disabled={rows.length === 1} />
                {line ? (
                  <Text variant="small" muted numeric style={styles.full}>
                    {`${formatPeso(line.amount)}${line.regularPrice !== undefined ? ` (their price; regular ${formatPeso(line.regularPrice * line.qty)})` : ''}`}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <View style={styles.addRow}>
            <Button title="Add another" icon="add" variant="secondary" size="sm" onPress={() => setRows([...rows, blankRow()])} />
          </View>
        </View>
        <View style={styles.field}>
          <Text variant="label">Paid now (optional)</Text>
          <View style={styles.pair}>
            <TextField
              prefix="₱"
              placeholder="0.00"
              value={pay.values.amount}
              onChangeText={(amount) => pay.set('amount', amount)}
              error={pay.errors.amount}
              keyboardType="decimal-pad"
              accessibilityLabel="Amount paid now"
              containerStyle={styles.half}
            />
            {pay.values.amount ? (
              <SegmentedControl
                accessibilityLabel="Paid with"
                options={PAYMENT_METHODS.map((method) => ({ label: PAYMENT_LABELS[method], value: method }))}
                value={pay.values.method}
                onChange={(method) => pay.set('method', method)}
              />
            ) : null}
          </View>
          {pay.values.amount && pay.values.method !== 'cash' ? (
            <TextField label="Reference no." value={pay.values.reference} onChangeText={(reference) => pay.set('reference', reference)} error={pay.errors.reference} />
          ) : null}
          <Text variant="small" muted>
            Leave it blank if they pay nothing now. Later payments, and post-dated cheques, go through Record payment.
          </Text>
        </View>
        <View style={[styles.summary, { backgroundColor: colors.primarySoft }]}>
          <Text>
            {customer && cart.length > 0
              ? `${customer.name} takes ${lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} now${
                  paidNow ? `, pays ${formatPeso(paidNow.amount)} now (${PAYMENT_LABELS[paidNow.method]})` : ''
                } and pays ${formatPeso(later)} later. Refills swap their empties as usual.`
              : 'Choose who is buying and what they take. Refills, new cylinders, accessories and sets can all be sold on credit.'}
          </Text>
        </View>
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </Dialog>
      <CustomerPickerDialog
        visible={visible && choosing}
        title="Who is buying on credit?"
        onClose={() => setChoosing(false)}
        onPick={(picked) => {
          setCustomer(picked);
          setChoosing(false);
        }}
      />
    </>
  );
}

/** The owner, an admin or the branch manager marks a deposited cheque cleared, or bounced (owed again). */
function SettleChequeDialog({ cheque, onClose }: { cheque: ChequeInfo | null; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cheque) {
      setNote('');
      setError(null);
    }
  }, [cheque]);

  const settle = async (outcome: 'cleared' | 'bounced') => {
    if (!cheque) return;
    if (outcome === 'bounced' && note.trim().length < 3) return setError('Say why it bounced, like "Insufficient funds".');
    setBusy(true);
    setError(null);
    try {
      await settleCheque(work.ctx, { paymentId: cheque.entry.id, outcome, note });
      toast.show(
        outcome === 'cleared' ? 'Cheque marked cleared.' : `Cheque marked bounced. ${cheque.entry.borrowerName} owes ${formatPeso(cheque.amount)} again.`,
        outcome === 'cleared' ? 'success' : 'info',
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={!!cheque}
      title="Post-dated cheque"
      onClose={onClose}
      dismissable={!busy}
      width={480}
      actions={
        <>
          <Button title="Bounced" variant="danger" onPress={() => void settle('bounced')} disabled={busy} />
          <Button title="Cleared" icon="checkmark" onPress={() => void settle('cleared')} loading={busy} />
        </>
      }
    >
      {cheque ? (
        <>
          <Text>
            {`${formatPeso(cheque.amount)} from ${cheque.entry.borrowerName}: ${cheque.cheque.bank} cheque no. ${cheque.cheque.number}, can be cashed on ${formatDay(cheque.cheque.cashOn)}.`}
          </Text>
          <TextField label="Note (required if it bounced)" value={note} onChangeText={setNote} placeholder="e.g. Deposited at BPI Ipil" />
        </>
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
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
        allowCheque
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
                On account{entry.saleId && salesById.get(entry.saleId) ? ` · ${salesById.get(entry.saleId)!.receiptNo}` : ''}
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
  smallQty: { width: 70 },
  itemRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  addRow: { flexDirection: 'row' },
  full: { flexBasis: '100%' },
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

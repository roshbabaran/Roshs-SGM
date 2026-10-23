import {
  approveClaim,
  approvesClaims,
  canReturnFrom,
  CLAIM_LABELS,
  CLAIM_STATUS_LABELS,
  defectiveCharge,
  defectiveChargeText,
  defectiveItemText,
  formatDateTime,
  formatPeso,
  ordersToPickUp,
  parsePeso,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  pendingClaims,
  pricePerKg,
  recordPickup,
  rejectClaim,
  requestDefective,
  requestReturn,
  returnRefund,
  saleProgress,
  worksAt,
  type Claim,
  type CounterPaymentMethod,
  type CustomerRef,
  type Product,
  type Sale,
  type User,
} from '@sgm/core';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

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
import { CustomerField, CustomerPickerDialog } from './CustomerPicker';

type Tab = 'pickups' | 'approvals' | 'history';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const itemsText = (sale: Sale) => sale.lines.map((l) => `${l.qty} × ${l.name}`).join(', ');
const claimItems = (claim: Claim) => (claim.kind === 'defective' ? defectiveItemText(claim) : claim.items.map((i) => `${i.qty} × ${i.name}`).join(', '));
const claimAmount = (claim: Claim) =>
  claim.kind === 'return' ? `refund ${formatPeso(claim.refund ?? 0)}` : claim.kind === 'defective' ? `charge ${formatPeso(claim.charge ?? 0)}` : '';
const STATUS_TONE: Record<Claim['status'], 'warning' | 'success' | 'danger'> = { pending: 'warning', completed: 'success', rejected: 'danger' };

/**
 * Claims: prepaid orders picked up, items returned, and defective cylinders
 * or accessories exchanged. Cashiers record all three; a cashier's return or exchange waits
 * for the owner, an admin or the branch manager to approve it.
 */
export function ClaimsScreen() {
  const work = useWork();
  const { data: sales } = useCollection<Sale>('sales');
  const { data: claims } = useCollection<Claim>('claims');
  const { data: users } = useCollection<User>('users');
  const approver = approvesClaims(work.user);
  const [tab, setTab] = useState<Tab>(approver && pendingClaims(claims, work.user).length > 0 ? 'approvals' : 'pickups');
  const [pickingUp, setPickingUp] = useState<Sale | null>(null);
  const [returning, setReturning] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const [deciding, setDeciding] = useState<Claim | null>(null);

  const toPickUp = ordersToPickUp(sales, claims);
  // Cashiers see their own requests; approvers see everyone's at the branches they decide for.
  const shownWaiting = approver ? pendingClaims(claims, work.user) : pendingClaims(claims).filter((c) => c.requestedBy === work.user?.id);
  const history = [...claims].sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  const userName = (id: string | undefined) => (id ? (users.find((u) => u.id === id)?.displayName ?? id) : '');
  const locationName = (id: string) => work.locations.find((l) => l.id === id)?.name ?? id;

  const pickupColumns: Column<Sale>[] = [
    { key: 'when', title: 'Paid', width: 170, text: (s) => formatDateTime(s.createdAt), sortValue: (s) => s.createdAt },
    { key: 'customer', title: 'Customer', flex: 1.2, text: (s) => s.borrowerName ?? '' },
    { key: 'receipt', title: 'Receipt', width: 150, text: (s) => `${s.receiptNo} ${s.claimCode ?? ''}`, render: (s) => <Text>{s.receiptNo}</Text> },
    {
      key: 'items',
      title: 'Still to pick up',
      flex: 2,
      text: (s) =>
        saleProgress(s, claims)
          .filter((p) => p.toPickUp > 0)
          .map((p) => `${p.toPickUp} × ${p.name}`)
          .join(', '),
    },
    { key: 'branch', title: 'Paid at', width: 140, text: (s) => locationName(s.locationId) },
    { key: 'total', title: 'Paid', width: 110, align: 'right', text: (s) => formatPeso(s.total), sortValue: (s) => s.total },
  ];

  const claimColumns: Column<Claim>[] = [
    { key: 'when', title: 'When', width: 170, text: (c) => formatDateTime(c.decidedAt ?? c.createdAt), sortValue: (c) => c.decidedAt ?? c.createdAt },
    { key: 'kind', title: 'What', width: 150, text: (c) => CLAIM_LABELS[c.kind] },
    { key: 'customer', title: 'Customer', flex: 1, text: (c) => c.customerName ?? '' },
    { key: 'items', title: 'Items', flex: 2, text: (c) => [c.receiptNo, claimItems(c), claimAmount(c)].filter(Boolean).join(' · ') },
    { key: 'by', title: 'Asked by', width: 140, text: (c) => userName(c.requestedBy) },
    {
      key: 'status',
      title: 'Status',
      width: 170,
      text: (c) => CLAIM_STATUS_LABELS[c.status],
      render: (c) => <Badge label={CLAIM_STATUS_LABELS[c.status]} tone={STATUS_TONE[c.status]} />,
    },
  ];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Claims"
        subtitle="Prepaid orders picked up, returns, and defective cylinders or accessories exchanged."
        actions={
          <>
            <Button title="Return items" icon="return-down-back-outline" variant="secondary" onPress={() => setReturning(true)} />
            <Button title="Defective exchange" icon="construct-outline" variant="secondary" onPress={() => setExchanging(true)} />
          </>
        }
      />
      <View style={styles.tiles}>
        <StatTile label="Prepaid orders to pick up" value={String(toPickUp.length)} icon="bag-handle-outline" tone={toPickUp.length > 0 ? 'info' : 'neutral'} />
        <StatTile
          label={approver ? 'Waiting for your approval' : 'Your requests waiting'}
          value={String(shownWaiting.length)}
          hint={approver ? undefined : 'The owner, an admin or the branch manager approves returns and exchanges'}
          icon="hourglass-outline"
          tone={shownWaiting.length > 0 ? 'warning' : 'neutral'}
        />
      </View>
      <Card padded>
        <SegmentedControl
          accessibilityLabel="Show"
          options={[
            { label: `Pick ups (${toPickUp.length})`, value: 'pickups' },
            { label: `${approver ? 'Approvals' : 'Waiting'} (${shownWaiting.length})`, value: 'approvals' },
            { label: 'History', value: 'history' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'pickups' ? (
          <>
            <DataTable
              rows={toPickUp}
              columns={pickupColumns}
              rowKey={(s) => s.id}
              onRowPress={setPickingUp}
              searchPlaceholder="Search by customer, receipt or claim code"
              emptyText="No prepaid orders are waiting. Tick Prepaid on the Sell screen to take one."
              minWidth={900}
            />
            <Text variant="small" muted>
              Click an order to release it. The customer shows the receipt with its claim code.
            </Text>
          </>
        ) : tab === 'approvals' ? (
          <>
            <DataTable
              rows={shownWaiting}
              columns={claimColumns}
              rowKey={(c) => c.id}
              onRowPress={setDeciding}
              emptyText={approver ? 'Nothing is waiting for approval.' : 'None of your requests are waiting.'}
              minWidth={900}
            />
            {approver ? (
              <Text variant="small" muted>
                Click a request to approve or reject it. Approving records the stock and the refund or charge at the branch that asked.
              </Text>
            ) : null}
          </>
        ) : (
          <DataTable
            rows={history}
            columns={claimColumns}
            rowKey={(c) => c.id}
            onRowPress={setDeciding}
            searchPlaceholder="Search claims"
            emptyText="No pick ups, returns or exchanges yet."
            minWidth={900}
          />
        )}
      </Card>
      <PickupDialog sale={pickingUp} claims={claims} onClose={() => setPickingUp(null)} />
      <ReturnDialog visible={returning} sales={sales} claims={claims} onClose={() => setReturning(false)} />
      <DefectiveDialog visible={exchanging} sales={sales} onClose={() => setExchanging(false)} />
      <ClaimDialog claim={deciding} userName={userName} onClose={() => setDeciding(null)} />
    </ScrollView>
  );
}

/** How many of each line to hand over or take back, as typed. */
function QtyRows({
  rows,
  values,
  onChange,
}: {
  rows: { line: number; name: string; max: number; note?: string }[];
  values: Record<number, string>;
  onChange: (line: number, qty: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.list, { borderColor: colors.border }]}>
      {rows.map((row) => (
        <View key={row.line} style={[styles.listRow, { borderBottomColor: colors.border }]}>
          <View style={styles.flex}>
            <Text weight="600">{row.name}</Text>
            <Text variant="small" muted>
              {row.note ?? `Up to ${row.max}`}
            </Text>
          </View>
          {row.max > 0 ? (
            <TextField
              value={values[row.line] ?? ''}
              onChangeText={(v) => onChange(row.line, v.replace(/\D/g, ''))}
              keyboardType="number-pad"
              accessibilityLabel={`How many ${row.name}`}
              containerStyle={styles.qty}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

const picked = (values: Record<number, string>) =>
  Object.entries(values)
    .map(([line, qty]) => ({ line: Number(line), qty: parseInt(qty, 10) || 0 }))
    .filter((item) => item.qty > 0);

function PickupDialog({ sale, claims, onClose }: { sale: Sale | null; claims: Claim[]; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const [qty, setQty] = useState<Record<number, string>>({});
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = sale ? saleProgress(sale, claims) : [];

  useEffect(() => {
    if (!sale) return;
    setQty(Object.fromEntries(saleProgress(sale, claims).filter((p) => p.toPickUp > 0).map((p) => [p.line, String(p.toPickUp)])));
    setCode('');
    setError(null);
    // Only when a different order is opened, so a sync doesn't clear what was typed.
  }, [sale?.id]);

  const release = async () => {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      const claim = await recordPickup(work.ctx, { saleId: sale.id, items: picked(qty), claimCode: code });
      toast.show(`Released ${claim.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}${sale.borrowerName ? ` to ${sale.borrowerName}` : ''}.`, 'success');
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={!!sale}
      title={`Pick up: ${sale?.borrowerName ?? ''}`}
      onClose={onClose}
      dismissable={!busy}
      width={560}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Release items" icon="checkmark" onPress={release} loading={busy} />
        </>
      }
    >
      {sale ? (
        <Text muted>
          {`Receipt ${sale.receiptNo}, paid ${formatPeso(sale.total)} on ${formatDateTime(sale.createdAt)}. The items leave the shelf at ${work.location?.name ?? 'this branch'} now.`}
        </Text>
      ) : null}
      <QtyRows
        rows={progress
          .filter((p) => p.toPickUp > 0)
          .map((p) => ({ line: p.line, name: p.name, max: p.toPickUp, note: `${p.toPickUp} left to pick up${p.pickedUp > 0 ? ` (${p.pickedUp} already picked up)` : ''}` }))}
        values={qty}
        onChange={(line, v) => setQty({ ...qty, [line]: v })}
      />
      <TextField
        label="Claim code on the receipt"
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect={false}
        hint={approvesClaims(work.user) ? 'If the receipt is lost you may leave it blank, after checking who the customer is.' : 'Six letters and numbers, printed on the prepaid receipt.'}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const refundOptions = PAYMENT_METHODS.map((m) => ({ label: PAYMENT_LABELS[m], value: m }));

function ReturnDialog({ visible, sales, claims, onClose }: { visible: boolean; sales: Sale[]; claims: Claim[]; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
  const [sale, setSale] = useState<Sale | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [method, setMethod] = useState<CounterPaymentMethod>('cash');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setSale(null);
      setQty({});
      setMethod('cash');
      setReason('');
      setError(null);
    }
  }, [visible]);

  // Sales with something that can still come back: LPG the customer took can't.
  const recent = sales.filter((s) => canReturnFrom(s, claims)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const progress = sale ? saleProgress(sale, claims) : [];
  const items = picked(qty);
  const refund = sale && items.length > 0 ? returnRefund(sale, claims, items) : null;
  const onAccount = sale?.payment.method === 'credit';
  const approver = approvesClaims(work.user);

  const saleColumns: Column<Sale>[] = [
    { key: 'when', title: 'When', width: 160, text: (s) => formatDateTime(s.createdAt), sortValue: (s) => s.createdAt },
    { key: 'receipt', title: 'Receipt', width: 140, text: (s) => s.receiptNo },
    { key: 'customer', title: 'Customer', flex: 1, text: (s) => s.borrowerName ?? '' },
    { key: 'items', title: 'Items', flex: 2, text: itemsText },
    { key: 'total', title: 'Total', width: 110, align: 'right', text: (s) => formatPeso(s.total), sortValue: (s) => s.total },
  ];

  const submit = async () => {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      const claim = await requestReturn(work.ctx, { saleId: sale.id, items, refundMethod: method, reason });
      toast.show(
        claim.status === 'pending'
          ? 'Return sent for approval. Give the refund once the owner, an admin or the branch manager approves it.'
          : claim.voidsSale
            ? `Everything returned: sale ${sale.receiptNo} is voided.`
            : `Return recorded. Refund ${formatPeso(claim.refund ?? 0)}.`,
        'success',
      );
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={visible}
      title={sale ? `Return from ${sale.receiptNo}` : 'Return items: find the sale'}
      onClose={onClose}
      dismissable={!busy}
      width={sale ? 600 : 900}
      actions={
        sale ? (
          <>
            <Button title="Choose another sale" variant="ghost" onPress={() => setSale(null)} disabled={busy} />
            <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            <Button title={approver ? 'Record return' : 'Ask for approval'} icon="checkmark" onPress={submit} loading={busy} disabled={items.length === 0} />
          </>
        ) : (
          <Button title="Cancel" variant="secondary" onPress={onClose} />
        )
      }
    >
      {!sale ? (
        <DataTable
          rows={recent}
          columns={saleColumns}
          rowKey={(s) => s.id}
          onRowPress={(s) => {
            setSale(s);
            setQty({});
          }}
          searchPlaceholder="Search by receipt number, customer or item"
          emptyText="No sales to return. LPG can't be returned once the customer has it."
          pageSize={8}
          minWidth={760}
        />
      ) : (
        <>
          <Text muted>{`${sale.borrowerName ? `${sale.borrowerName} · ` : ''}${itemsText(sale)} · ${formatPeso(sale.total)} by ${PAYMENT_LABELS[sale.payment.method]}`}</Text>
          <QtyRows
            rows={progress.map((p) => {
              const left = p.returnable - p.pendingReturn;
              return {
                line: p.line,
                name: p.name,
                max: left,
                note:
                  left <= 0
                    ? p.lpg && p.qty - p.returned > 0
                      ? "LPG can't be returned"
                      : 'Nothing left to return'
                    : `Up to ${left}${p.lpg ? ', not picked up yet' : ''}${p.returned > 0 ? ` (${p.returned} returned before)` : ''}${p.pendingReturn > 0 ? ` (${p.pendingReturn} waiting for approval)` : ''}`,
              };
            })}
            values={qty}
            onChange={(line, v) => setQty({ ...qty, [line]: v })}
          />
          {onAccount ? (
            <Text variant="small" muted>
              {sale.downPayment
                ? `This sale was on credit, so it can only be returned whole. The ${formatPeso(sale.downPayment.amount)} they paid when they took it goes back to them by ${PAYMENT_LABELS[sale.downPayment.method]}; the rest comes off what they owe.`
                : 'This sale was on credit, so the refund comes off what they owe. It can only be returned whole.'}
            </Text>
          ) : (
            <View style={styles.field}>
              <Text variant="label">Refund by</Text>
              <SegmentedControl options={refundOptions} value={method} onChange={setMethod} size="sm" />
            </View>
          )}
          <TextField label="Why is it being returned?" value={reason} onChangeText={setReason} multiline />
          {refund ? (
            <View style={[styles.summary, { backgroundColor: colors.primarySoft }]}>
              <Text>
                {`Refund ${formatPeso(refund.refund)}${refund.voidsSale ? '. Everything comes back, so the sale is voided' : ''}. ${
                  approver ? 'The stock goes back on the shelf now.' : 'It waits for the owner, an admin or the branch manager to approve it before anything changes.'
                }`}
              </Text>
            </View>
          ) : null}
        </>
      )}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

function DefectiveDialog({ visible, sales, onClose }: { visible: boolean; sales: Sale[]; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
  const { data: products } = useCollection<Product>('products');
  const [customer, setCustomer] = useState<CustomerRef | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [productId, setProductId] = useState('');
  const [lostKg, setLostKg] = useState('');
  const [chargeText, setChargeText] = useState('');
  const [method, setMethod] = useState<CounterPaymentMethod>('cash');
  const [reason, setReason] = useState('');
  const [receiptNo, setReceiptNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setCustomer(null);
      setProductId('');
      setLostKg('');
      setChargeText('');
      setMethod('cash');
      setReason('');
      setReceiptNo('');
      setError(null);
    }
  }, [visible]);

  const product = products.find((p) => p.id === productId);
  const cylinder = product?.kind === 'cylinder';
  const kg = Number(lostKg);
  const validKg = /^\d+(\.\d{1,2})?$/.test(lostKg.trim()) && product?.sizeKg !== undefined && kg >= 0 && kg <= product.sizeKg;
  // An accessory is usually swapped for free; a blank charge means free.
  const accessoryCharge = chargeText.trim() ? parsePeso(chargeText) : 0;
  const validCharge = accessoryCharge !== null && !!product && accessoryCharge <= product.price;
  const charge = !product ? null : cylinder ? (validKg ? defectiveCharge(product, kg) : null) : validCharge ? accessoryCharge : null;
  const approver = approvesClaims(work.user);
  const thing = cylinder ? 'cylinder' : 'item';

  const submit = async () => {
    if (!product) return setError('Choose the cylinder or accessory being exchanged.');
    if (cylinder && !validKg) return setError(`Enter the gas it lost, from 0 to ${product.sizeKg ?? 0} kg, like 1.5.`);
    if (!cylinder && !validCharge) return setError(`Enter a charge from ₱0 to ${formatPeso(product.price)}, or leave it blank.`);
    const sale = receiptNo.trim() ? sales.find((s) => s.receiptNo.toLowerCase() === receiptNo.trim().toLowerCase()) : undefined;
    if (receiptNo.trim() && !sale) return setError(`No sale has receipt no. ${receiptNo.trim()}. Check it, or leave it blank.`);
    setBusy(true);
    setError(null);
    try {
      const claim = await requestDefective(work.ctx, {
        customer,
        productId: product.id,
        ...(cylinder ? { lostKg: kg } : { charge: accessoryCharge ?? 0 }),
        chargeMethod: method,
        reason,
        saleId: sale?.id,
      });
      toast.show(
        claim.status === 'pending'
          ? `Exchange sent for approval. Swap the ${thing} once the owner, an admin or the branch manager approves it.`
          : `Exchange recorded. ${claim.charge ? `Charge ${formatPeso(claim.charge)}.` : 'No charge.'}`,
        'success',
      );
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        visible={visible && !choosing}
        title="Defective exchange"
        onClose={onClose}
        dismissable={!busy}
        width={560}
        actions={
          <>
            <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            <Button title={approver ? 'Record exchange' : 'Ask for approval'} icon="checkmark" onPress={submit} loading={busy} />
          </>
        }
      >
        <Text muted>
          The customer gets a new one in place of the defective one. For a cylinder they pay only for the gas it lost; an accessory is usually free. The defective
          one is counted apart in Inventory until it goes back to the depot.
        </Text>
        <CustomerField customer={customer} onChoose={() => setChoosing(true)} onClear={() => setCustomer(null)} />
        <Select
          label="Cylinder or accessory"
          value={productId}
          options={products
            .filter((p) => p.active && (p.kind === 'cylinder' || p.kind === 'accessory'))
            .map((p) => ({
              label: p.name,
              value: p.id,
              hint: p.kind === 'cylinder' ? `${formatPeso(pricePerKg(p))} per kg` : `Accessory · ${formatPeso(p.price)}`,
            }))}
          onChange={(id) => {
            setProductId(id);
            setLostKg('');
            setChargeText('');
          }}
        />
        <View style={styles.pair}>
          {product && !cylinder ? (
            <TextField
              label="Charge (optional)"
              value={chargeText}
              onChangeText={(v) => setChargeText(v.replace(/[^\d.,]/g, ''))}
              keyboardType="decimal-pad"
              containerStyle={styles.half}
              hint="Leave blank if the exchange is free."
            />
          ) : (
            <TextField
              label="Gas it lost (kg)"
              value={lostKg}
              onChangeText={(v) => setLostKg(v.replace(/[^\d.]/g, ''))}
              keyboardType="decimal-pad"
              containerStyle={styles.half}
              hint={product?.sizeKg ? `Its size (${product.sizeKg} kg) less the gas still in it.` : undefined}
            />
          )}
          <TextField label="Receipt no. (optional)" value={receiptNo} onChangeText={setReceiptNo} containerStyle={styles.half} autoCapitalize="characters" />
        </View>
        {charge !== 0 ? (
          <View style={styles.field}>
            <Text variant="label">Customer pays by</Text>
            <SegmentedControl options={refundOptions} value={method} onChange={setMethod} size="sm" />
          </View>
        ) : null}
        <TextField label="What is wrong with it?" value={reason} onChangeText={setReason} multiline placeholder={cylinder || !product ? 'e.g. Leaking valve' : 'e.g. Knob is broken'} />
        <View style={[styles.summary, { backgroundColor: colors.primarySoft }]}>
          <Text>
            {charge === null
              ? product
                ? cylinder
                  ? 'Enter the gas it lost to see the charge.'
                  : `Enter a charge up to ${formatPeso(product.price)}, or leave it blank.`
                : 'Choose the cylinder or accessory being exchanged.'
              : `${charge === 0 ? 'No charge' : `Charge ${formatPeso(charge)}`}${cylinder ? ` (${kg} kg × ${formatPeso(pricePerKg(product!))})` : ''}. ${
                  approver ? `The new ${thing} leaves the shelf now.` : 'It waits for the owner, an admin or the branch manager to approve it.'
                }`}
          </Text>
        </View>
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </Dialog>
      <CustomerPickerDialog
        visible={visible && choosing}
        title="Whose is it?"
        onClose={() => setChoosing(false)}
        onPick={(c) => {
          setCustomer(c);
          setChoosing(false);
        }}
      />
    </>
  );
}

/** A claim's details; the owner, an admin or the branch manager approves or rejects one that is waiting. */
function ClaimDialog({ claim, userName, onClose }: { claim: Claim | null; userName: (id: string | undefined) => string; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDecide = !!claim && claim.status === 'pending' && approvesClaims(work.user) && worksAt(work.user, claim.locationId);

  useEffect(() => {
    setNote('');
    setError(null);
  }, [claim?.id]);

  const decide = async (approve: boolean) => {
    if (!claim) return;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        const done = await approveClaim(work.ctx, claim.id, note);
        toast.show(
          done.kind === 'return'
            ? `Approved. Refund ${formatPeso(done.refund ?? 0)}${done.voidsSale ? '; the sale is voided' : ''}.`
            : `Approved. ${done.charge ? `Charge ${formatPeso(done.charge)}` : 'No charge'}; swap the ${done.lostKg !== undefined ? 'cylinder' : 'item'}.`,
          'success',
        );
      } else {
        await rejectClaim(work.ctx, claim.id, note);
        toast.show('Rejected.', 'info');
      }
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!claim) return <Dialog visible={false} title="" onClose={onClose}>{null}</Dialog>;
  const rows: [string, string][] = [
    ['Status', CLAIM_STATUS_LABELS[claim.status]],
    ['Customer', claim.customerName ?? '—'],
    ...(claim.receiptNo ? ([['Receipt', claim.receiptNo]] as [string, string][]) : []),
    ['Items', claimItems(claim)],
    ...(claim.kind === 'return'
      ? ([
          ['Refund', `${formatPeso(claim.refund ?? 0)} by ${claim.refundMethod ? PAYMENT_LABELS[claim.refundMethod] : '—'}${claim.voidsSale ? ' (voids the sale)' : ''}`],
        ] as [string, string][])
      : claim.kind === 'defective'
        ? ([['Charge', claim.charge ? `${defectiveChargeText(claim)} by ${claim.chargeMethod ? PAYMENT_LABELS[claim.chargeMethod] : '—'}` : defectiveChargeText(claim)]] as [
            string,
            string,
          ][])
        : []),
    ...(claim.reason ? ([['Reason', claim.reason]] as [string, string][]) : []),
    [claim.kind === 'pickup' ? 'Released by' : 'Asked by', `${userName(claim.requestedBy)} · ${formatDateTime(claim.createdAt)}`],
    ...(claim.decidedBy && claim.kind !== 'pickup'
      ? ([[claim.status === 'rejected' ? 'Rejected by' : 'Approved by', `${userName(claim.decidedBy)} · ${formatDateTime(claim.decidedAt ?? '')}`]] as [string, string][])
      : []),
    ...(claim.decisionNote ? ([['Note', claim.decisionNote]] as [string, string][]) : []),
  ];

  return (
    <Dialog
      visible
      title={CLAIM_LABELS[claim.kind]}
      onClose={onClose}
      dismissable={!busy}
      width={540}
      actions={
        canDecide ? (
          <>
            <Button title="Reject" variant="danger" onPress={() => void decide(false)} disabled={busy} />
            <Button title="Approve" icon="checkmark" onPress={() => void decide(true)} loading={busy} />
          </>
        ) : (
          <Button title="Close" variant="secondary" onPress={onClose} />
        )
      }
    >
      {rows.map(([label, value]) => (
        <View key={label} style={styles.detail}>
          <Text variant="label" style={styles.detailLabel}>
            {label}
          </Text>
          <Text style={styles.flex}>{value}</Text>
        </View>
      ))}
      {canDecide ? (
        <TextField label="Note (required to reject)" value={note} onChangeText={setNote} multiline placeholder="e.g. Checked the cylinder; the valve leaks" />
      ) : claim.status === 'pending' ? (
        <EmptyState icon="hourglass-outline" title="Waiting for approval" message="The owner, an admin or the branch manager approves it from their Claims window." />
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  list: { borderWidth: 1, borderRadius: radius.md, overflow: 'hidden' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  qty: { width: 80 },
  field: { gap: spacing.xs },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'flex-start' },
  half: { flexGrow: 1, flexBasis: 200 },
  summary: { borderRadius: radius.md, padding: spacing.md },
  detail: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  detailLabel: { width: 110 },
  flex: { flex: 1 },
});

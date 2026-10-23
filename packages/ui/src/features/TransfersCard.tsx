import {
  acceptsTransfersAt,
  acceptTransfer,
  formatDateTime,
  openTransfers,
  settlesTransfersFrom,
  settleTransfer,
  transferQtyText,
  type Product,
  type Settlement,
  type StockMovement,
  type Transfer,
  type User,
} from '@sgm/core';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Badge, Banner, Card } from '../Basics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Icon } from '../Icon';
import { PagedList } from '../PagedList';
import { useCollection, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, useTheme } from '../theme';
import { useToast } from '../Toast';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Names for the rows and dialogs. */
interface Names {
  product: (id: string) => string;
  place: (id: string) => string;
  person: (id: string) => string;
}

function useNames(): Names {
  const work = useWork();
  const { data: products } = useCollection<Product>('products');
  const { data: users } = useCollection<User>('users');
  return {
    product: (id) => products.find((p) => p.id === id)?.name ?? id,
    place: (id) => work.locations.find((l) => l.id === id)?.name ?? id,
    person: (id) => users.find((u) => u.id === id)?.displayName ?? id,
  };
}

/** "1 short" or "2 extra". */
const differenceText = (t: Transfer) => `${Math.abs(t.difference)} ${t.difference > 0 ? 'short' : 'extra'}`;

/**
 * Stock on its way to or from this branch, and counts that didn't match. Stock
 * sent here is accepted by the branch's manager or warehouse staff, an admin or
 * the owner; a count that didn't match is settled by the branch that sent it.
 */
export function TransfersCard() {
  const work = useWork();
  const { colors } = useTheme();
  const names = useNames();
  const { data: movements } = useCollection<StockMovement>('movements');
  const [accepting, setAccepting] = useState<Transfer | null>(null);
  const [settling, setSettling] = useState<Transfer | null>(null);
  const here = work.locationId;
  const canAccept = acceptsTransfersAt(work.user, here);
  const canSettle = settlesTransfersFrom(work.user, here);
  const mine = (t: Transfer) => (t.state === 'on-the-way' ? t.toId === here && canAccept : t.fromId === here && canSettle);
  // What this person can act on first, then the rest, newest first.
  const open = openTransfers(movements, here).sort((a, b) => Number(mine(b)) - Number(mine(a)));

  if (open.length === 0) return null;
  const toAct = open.filter(mine).length;

  return (
    <Card title={`Stock between branches${toAct > 0 ? ` (${toAct} for you)` : ''}`} padded>
      <View style={styles.note}>
        <Text variant="small" muted>
          Stock sent here waits until the branch manager, warehouse staff, an admin or the owner counts it and accepts it. When the count doesn't match what was
          sent, the branch that sent it checks its stock and settles the difference.
        </Text>
      </View>
      <PagedList
        items={open}
        keyOf={(t) => t.id}
        renderItem={(t) => {
          const incoming = t.toId === here;
          const what = `${names.product(t.productId)} · ${transferQtyText(t.qty, t.condition)}`;
          const detail =
            t.state === 'on-the-way'
              ? `${incoming ? `From ${names.place(t.fromId)}` : `To ${names.place(t.toId)}`} · sent ${formatDateTime(t.sent.occurredAt)} by ${names.person(t.sent.userId)}`
              : incoming
                ? `${names.person(t.accepted!.userId)} counted ${t.arrived} of ${t.qty} · ${names.place(t.fromId)} settles it`
                : `${names.place(t.toId)} counted ${t.arrived} of ${t.qty}`;
          const action =
            t.state === 'on-the-way' ? (
              incoming && canAccept ? (
                <Button title="Accept" icon="checkmark" size="sm" onPress={() => setAccepting(t)} accessibilityLabel={`Accept ${what} from ${names.place(t.fromId)}`} />
              ) : (
                <Badge label={incoming ? 'Waiting to be accepted' : 'On the way'} tone={incoming ? 'warning' : 'neutral'} />
              )
            ) : !incoming && canSettle ? (
              <Button title="Settle" icon="scale-outline" size="sm" variant="secondary" onPress={() => setSettling(t)} accessibilityLabel={`Settle ${what} sent to ${names.place(t.toId)}`} />
            ) : (
              <Badge label={differenceText(t)} tone="danger" />
            );
          return (
            <View style={[styles.row, { borderBottomColor: colors.border }]}>
              <Icon
                name={t.state === 'mismatch' ? 'alert-circle-outline' : incoming ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
                color={t.state === 'mismatch' ? colors.danger : incoming ? colors.primary : colors.textMuted}
              />
              <View style={styles.rowText}>
                <Text>{what}</Text>
                <Text variant="small" muted>
                  {detail}
                </Text>
                {t.state === 'mismatch' && t.accepted?.reason ? (
                  <Text variant="small" muted>
                    {`“${t.accepted.reason}”`}
                  </Text>
                ) : null}
              </View>
              {/* Beside the text when there is room, under it on a phone. */}
              <View style={styles.action}>{action}</View>
            </View>
          );
        }}
      />
      <AcceptDialog transfer={accepting} names={names} onClose={() => setAccepting(null)} />
      <SettleDialog transfer={settling} names={names} onClose={() => setSettling(null)} />
    </Card>
  );
}

/** Someone at the receiving branch counts what arrived and accepts it. */
function AcceptDialog({ transfer, names, onClose }: { transfer: Transfer | null; names: Names; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const [arrived, setArrived] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (transfer) {
      setArrived(String(transfer.qty));
      setNote('');
      setError(null);
    }
  }, [transfer]);

  if (!transfer) return null;
  const count = /^\d+$/.test(arrived.trim()) ? parseInt(arrived.trim(), 10) : null;
  const differs = count !== null && count !== transfer.qty;
  const from = names.place(transfer.fromId);

  const submit = async () => {
    if (count === null) return setError('Enter how many arrived.');
    setBusy(true);
    setError(null);
    try {
      const done = await acceptTransfer(work.ctx, transfer.id, count, note);
      toast.show(
        done.state === 'mismatch'
          ? `Accepted ${count} of ${transfer.qty}. ${from} settles the difference.`
          : `Accepted. ${transferQtyText(count, transfer.condition)} added to the stock here.`,
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
      visible
      title="Accept stock"
      onClose={onClose}
      dismissable={!busy}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Accept" icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      <Text>
        {`${transferQtyText(transfer.qty, transfer.condition)} of ${names.product(transfer.productId)}, sent from ${from} on ${formatDateTime(transfer.sent.occurredAt)} by ${names.person(transfer.sent.userId)}.`}
      </Text>
      {transfer.sent.reason ? (
        <Text variant="small" muted>
          {`Their note: ${transfer.sent.reason}`}
        </Text>
      ) : null}
      <TextField
        label="Actual stocks received"
        value={arrived}
        onChangeText={(v) => setArrived(v.replace(/\D/g, ''))}
        keyboardType="number-pad"
        hint="Count them before you accept. What arrived goes on the stock here."
      />
      {differs ? (
        <Banner tone="warning">
          {`${count < transfer.qty ? `${transfer.qty - count} short` : `${count - transfer.qty} more than was sent`}. ${from} checks its stock and settles the difference.`}
        </Banner>
      ) : null}
      <TextField
        label={differs ? 'What was different? (required)' : 'Note (optional)'}
        value={note}
        onChangeText={setNote}
        multiline
        placeholder={differs ? 'e.g. Only 9 on the truck' : undefined}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

/** The sending branch checks its stock and settles a count that didn't match. */
function SettleDialog({ transfer, names, onClose }: { transfer: Transfer | null; names: Names; onClose: () => void }) {
  const work = useWork();
  const toast = useToast();
  const { colors } = useTheme();
  const [how, setHow] = useState<Settlement | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (transfer) {
      setHow(null);
      setNote('');
      setError(null);
    }
  }, [transfer]);

  if (!transfer) return null;
  const n = Math.abs(transfer.difference);
  const short = transfer.difference > 0;
  const to = names.place(transfer.toId);
  const units = transferQtyText(n, transfer.condition);
  const options: { value: Settlement; title: string; detail: string }[] = short
    ? [
        { value: 'fix-count', title: n === 1 ? 'It never left here' : 'They never left here', detail: `Put ${units} back on the stock here.` },
        { value: 'leave', title: 'Lost on the way', detail: `Write off ${units}. Neither branch's stock changes.` },
      ]
    : [
        { value: 'fix-count', title: 'More was sent than recorded', detail: `Take ${units} more off the stock here.` },
        { value: 'leave', title: 'Leave the counts as they are', detail: `${to} keeps the extra. The stock here stays as it is.` },
      ];

  const submit = async () => {
    if (!how) return setError('Choose what happened.');
    setBusy(true);
    setError(null);
    try {
      await settleTransfer(work.ctx, transfer.id, how, note);
      toast.show('Settled.', 'success');
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible
      title="Settle a count that doesn't match"
      onClose={onClose}
      dismissable={!busy}
      width={560}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Settle" icon="checkmark" onPress={submit} loading={busy} />
        </>
      }
    >
      <Text>
        {`${to} counted ${transfer.arrived} of the ${transferQtyText(transfer.qty, transfer.condition)} of ${names.product(transfer.productId)} sent on ${formatDateTime(
          transfer.sent.occurredAt,
        )}, ${short ? `${n} short` : `${n} more than was sent`}.`}
      </Text>
      {transfer.accepted?.reason ? (
        <Text variant="small" muted>
          {`${names.person(transfer.accepted.userId)} wrote: ${transfer.accepted.reason}`}
        </Text>
      ) : null}
      <Text muted>Check the stock here, then choose what happened.</Text>
      <View style={styles.choices} accessibilityRole="radiogroup">
        {options.map((option) => {
          const active = option.value === how;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              onPress={() => setHow(option.value)}
              style={[styles.choice, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primarySoft : colors.surface }]}
            >
              <Icon name={active ? 'radio-button-on' : 'radio-button-off'} color={active ? colors.primary : colors.textMuted} />
              <View style={styles.flex}>
                <Text weight="600">{option.title}</Text>
                <Text variant="small" muted>
                  {option.detail}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <TextField label="What did you find? (required)" value={note} onChangeText={setNote} multiline placeholder="e.g. The tenth was still in the stock room" />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  note: { marginTop: -spacing.sm },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.md,
    rowGap: spacing.xs,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: 200 },
  action: { marginLeft: 'auto' },
  flex: { flex: 1 },
  choices: { gap: spacing.sm },
  choice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, cursor: 'pointer' },
});

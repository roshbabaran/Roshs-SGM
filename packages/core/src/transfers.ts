/**
 * Stock sent between the branches and the warehouse. Stocks Out takes it off the
 * sender's count as it leaves. It waits at the receiving branch until someone
 * there counts what arrived and accepts it: the owner, an admin, or that
 * branch's manager or warehouse staff (inventory.receive). What arrived goes on
 * the receiving branch's count.
 *
 * When the count doesn't match, the sending branch checks its own stock and
 * settles the difference:
 * - its count was wrong: what didn't arrive never left, so it goes back on the
 *   sender's count, or more was sent than recorded, so that comes off it;
 * - or the counts stay as they are: what is missing was lost on the way, or the
 *   receiving branch keeps the extra.
 *
 * Each step is a new movement, never a change to an old one. The movements that
 * accept and settle a Stocks Out take their ids from its id, so if two people
 * accept the same stock on two devices while offline, the server keeps the first
 * and the stock is counted once.
 */
import { ALLOW_NEGATIVE_STOCK } from './config';
import { levelOf, stockByProduct } from './ledger';
import { CONDITION_LABELS, type Location, type Product, type StockCondition, type StockMovement, type User } from './models';
import { saveAndQueue, StockError, type OpContext } from './operations';
import { assertCan, can, worksAt } from './roles';

/**
 * - on-the-way: sent, not accepted yet
 * - accepted: what arrived matches what was sent
 * - mismatch: accepted with a different count, waiting for the sending branch to settle it
 * - settled: the sending branch settled the difference
 */
export type TransferState = 'on-the-way' | 'accepted' | 'mismatch' | 'settled';

/** How the sending branch settles a count that doesn't match: fix its own count, or leave the counts as they are. */
export type Settlement = 'fix-count' | 'leave';

export interface Transfer {
  /** The Stocks Out's id. */
  id: string;
  sent: StockMovement;
  accepted: StockMovement | null;
  settled: StockMovement | null;
  fromId: string;
  toId: string;
  productId: string;
  condition: StockCondition;
  /** How many were sent. */
  qty: number;
  /** How many arrived, once accepted. */
  arrived: number | null;
  /** Sent less arrived: above 0 when some didn't arrive, below 0 when more arrived than was sent. */
  difference: number;
  state: TransferState;
}

/** The ids of the movements that accept and settle a Stocks Out. */
export const acceptedId = (transferId: string) => `${transferId}-in`;
export const settledId = (transferId: string) => `${transferId}-settled`;

/** Every Stocks Out that waits to be accepted (those recorded before 1.1.0 don't), newest first. */
export function transfers(movements: StockMovement[]): Transfer[] {
  const byId = new Map(movements.map((m) => [m.id, m]));
  const answer = (id: string, type: StockMovement['type'], transferId: string) => {
    const m = byId.get(id);
    return m && m.type === type && m.transferId === transferId ? m : null;
  };
  return movements
    .filter((m) => m.type === 'TRANSFER_OUT' && m.transferId === m.id && !!m.counterpartLocationId)
    .map((sent): Transfer => {
      const accepted = answer(acceptedId(sent.id), 'TRANSFER_IN', sent.id);
      const settled = accepted ? answer(settledId(sent.id), 'TRANSFER_FIX', sent.id) : null;
      const qty = -sent.qty;
      const arrived = accepted ? accepted.qty : null;
      const difference = arrived === null ? 0 : qty - arrived;
      return {
        id: sent.id,
        sent,
        accepted,
        settled,
        fromId: sent.locationId,
        toId: sent.counterpartLocationId!,
        productId: sent.productId,
        condition: sent.condition,
        qty,
        arrived,
        difference,
        state: !accepted ? 'on-the-way' : difference === 0 ? 'accepted' : settled ? 'settled' : 'mismatch',
      };
    })
    .sort((a, b) => b.sent.createdAt.localeCompare(a.sent.createdAt));
}

/** Stock on its way to or from this branch, and counts here or there that still need settling. */
export function openTransfers(movements: StockMovement[], locationId: string): Transfer[] {
  return transfers(movements).filter(
    (t) => (t.state === 'on-the-way' || t.state === 'mismatch') && (t.fromId === locationId || t.toId === locationId),
  );
}

/** Whether this person accepts stock arriving at this branch: the owner, an admin, or its manager or warehouse staff. */
export const acceptsTransfersAt = (user: User | null | undefined, locationId: string) => can(user, 'inventory.receive') && worksAt(user, locationId);

/** Whether this person settles counts for stock this branch sent: the same people, at the sending branch. */
export const settlesTransfersFrom = acceptsTransfersAt;

/** Stock this person can accept at this branch now. */
export function transfersToAccept(movements: StockMovement[], user: User | null | undefined, locationId: string): Transfer[] {
  if (!acceptsTransfersAt(user, locationId)) return [];
  return transfers(movements).filter((t) => t.state === 'on-the-way' && t.toId === locationId);
}

/** "10 full", "3 units", "2 defective". */
export function transferQtyText(qty: number, condition: StockCondition): string {
  if (condition === 'unit') return `${qty} ${Math.abs(qty) === 1 ? 'unit' : 'units'}`;
  return `${qty} ${CONDITION_LABELS[condition].toLowerCase()}`;
}

/** What the sending branch found, in a few words: "1 never left", "2 lost on the way". */
export function settlementText(transfer: Pick<Transfer, 'difference'>, how: Settlement): string {
  const n = Math.abs(transfer.difference);
  if (transfer.difference > 0) return how === 'fix-count' ? `${n} never left` : `${n} lost on the way`;
  return how === 'fix-count' ? `${n} more sent than recorded` : `${n} extra kept where ${n === 1 ? 'it' : 'they'} arrived`;
}

/** How a settled transfer was settled. */
export const settlementOf = (transfer: Transfer): Settlement | null => (!transfer.settled ? null : transfer.settled.qty === 0 ? 'leave' : 'fix-count');

const now = (ctx: OpContext) => (ctx.now?.() ?? new Date()).toISOString();

async function findTransfer(ctx: OpContext, transferId: string): Promise<{ transfer: Transfer; movements: StockMovement[] }> {
  const movements = await ctx.store.list<StockMovement>('movements');
  const transfer = transfers(movements).find((t) => t.id === transferId);
  if (!transfer) throw new Error('That Stocks Out is no longer in the records.');
  return { transfer, movements };
}

async function locationName(ctx: OpContext, id: string): Promise<string> {
  return (await ctx.store.get<Location>('locations', id))?.name ?? id;
}

/**
 * Someone at the receiving branch counts what arrived and accepts it, which puts
 * it on their count. A different count needs a note, and waits for the sending
 * branch to settle it.
 */
export async function acceptTransfer(ctx: OpContext, transferId: string, arrived: number, note = ''): Promise<Transfer> {
  const user = ctx.user;
  assertCan(user, 'inventory.receive');
  const { transfer, movements } = await findTransfer(ctx, transferId);
  if (!worksAt(user, transfer.toId)) {
    throw new Error(`This stock is going to ${await locationName(ctx, transfer.toId)}, so its manager or warehouse staff, an admin or the owner accepts it.`);
  }
  if (transfer.state !== 'on-the-way') throw new Error('This stock was already accepted.');
  if (!Number.isInteger(arrived) || arrived < 0 || arrived > 10_000) throw new Error('Enter how many arrived, as a whole number.');
  const why = note.trim();
  if (arrived !== transfer.qty && why.length < 3) {
    throw new Error(`${arrived} arrived but ${transfer.qty} were sent. Say what was different, so the sending branch can check (at least 3 characters).`);
  }
  if (why.length > 200) throw new Error('Keep the note under 200 characters.');
  const at = now(ctx);
  const movement: StockMovement = {
    id: acceptedId(transfer.id),
    type: 'TRANSFER_IN',
    productId: transfer.productId,
    locationId: transfer.toId,
    condition: transfer.condition,
    qty: arrived,
    ...(why ? { reason: why } : {}),
    counterpartLocationId: transfer.fromId,
    transferId: transfer.id,
    userId: user.id,
    deviceId: ctx.deviceId,
    occurredAt: at,
    createdAt: at,
    receivedAt: null,
  };
  await ctx.store.batch(saveAndQueue('movements', [movement], at));
  return transfers([...movements, movement]).find((t) => t.id === transfer.id)!;
}

/**
 * The sending branch settles a count that didn't match, after checking its own
 * stock: it fixes its count to match what arrived, or leaves both counts as they
 * are (lost on the way, or the receiving branch keeps the extra).
 */
export async function settleTransfer(ctx: OpContext, transferId: string, how: Settlement, note: string): Promise<Transfer> {
  const user = ctx.user;
  assertCan(user, 'inventory.receive');
  const { transfer, movements } = await findTransfer(ctx, transferId);
  if (!worksAt(user, transfer.fromId)) {
    throw new Error(`This stock was sent from ${await locationName(ctx, transfer.fromId)}, so its manager or warehouse staff, an admin or the owner settles it.`);
  }
  if (transfer.state !== 'mismatch') {
    throw new Error(
      transfer.state === 'settled' ? 'This was already settled.' : transfer.state === 'on-the-way' ? 'This stock has not been accepted yet.' : 'The counts match, so there is nothing to settle.',
    );
  }
  const why = note.trim();
  if (why.length < 3) throw new Error('Say what you found when you checked (at least 3 characters).');
  if (why.length > 200) throw new Error('Keep the note under 200 characters.');
  // Missing ones that never left go back on the sender's count; more sent than recorded comes off it.
  const qty = how === 'fix-count' ? transfer.difference : 0;
  if (qty < 0 && !ALLOW_NEGATIVE_STOCK) {
    const available = levelOf(stockByProduct(movements, transfer.fromId), transfer.productId)[transfer.condition];
    if (available + qty < 0) {
      const product = await ctx.store.get<Product>('products', transfer.productId);
      const name = `${product?.name ?? 'A product'} (${CONDITION_LABELS[transfer.condition].toLowerCase()})`;
      throw new StockError([{ productId: transfer.productId, condition: transfer.condition, name, available, needed: -qty }]);
    }
  }
  const at = now(ctx);
  const movement: StockMovement = {
    id: settledId(transfer.id),
    type: 'TRANSFER_FIX',
    productId: transfer.productId,
    locationId: transfer.fromId,
    condition: transfer.condition,
    qty,
    reason: `${settlementText(transfer, how)}. ${why}`,
    counterpartLocationId: transfer.toId,
    transferId: transfer.id,
    userId: user.id,
    deviceId: ctx.deviceId,
    occurredAt: at,
    createdAt: at,
    receivedAt: null,
  };
  await ctx.store.batch(saveAndQueue('movements', [movement], at));
  return transfers([...movements, movement]).find((t) => t.id === transfer.id)!;
}

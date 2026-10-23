/**
 * The Claims window: prepaid orders picked up, items returned for a refund,
 * and defective cylinders exchanged. A cashier's return or defective exchange
 * waits for the owner, an admin or the branch manager to approve it (claims.approve); approving it
 * records the stock and money, at the branch where it was asked for.
 */
import { isBorrowingSale, lineUnits, stockChanges } from './cart';
import { ALLOW_NEGATIVE_STOCK } from './config';
import { uuid } from './ids';
import { levelOf, stockByProduct } from './ledger';
import type { Claim, ClaimItem, Customer, MovementType, PaymentMethod, Product, Sale, SaleLine, StockCondition, StockMovement, User } from './models';
import { formatPeso, type Centavos } from './money';
import {
  resolveCustomer,
  saveAndQueue,
  StockError,
  voidSaleOps,
  type CustomerRef,
  type OpContext,
  type Shortage,
} from './operations';
import { assertCan, can, worksAt } from './roles';
import type { StoreOp } from './store';

export const CLAIM_LABELS: Record<Claim['kind'], string> = {
  pickup: 'Pick up',
  return: 'Return',
  defective: 'Defective exchange',
};

export const CLAIM_STATUS_LABELS: Record<Claim['status'], string> = {
  pending: 'Waiting for approval',
  completed: 'Completed',
  rejected: 'Rejected',
};

/**
 * A line with LPG in it: a refill, a new or borrowed cylinder, or a set that holds one. LPG can't be returned once
 * the customer has it; only a prepaid order's LPG still waiting on the shelf can be given back for a refund.
 */
export function hasLpg(line: SaleLine): boolean {
  return lineUnits(line).some((unit) => unit.type !== 'item');
}

/** What has happened to one line of a sale: how much was picked up and returned, and what is left. */
export interface LineProgress {
  line: number;
  name: string;
  qty: number;
  /** It has LPG in it (hasLpg), so only what hasn't been picked up can be returned. */
  lpg: boolean;
  pickedUp: number;
  returned: number;
  /** Returned before it was picked up (prepaid orders), so no stock came back for it. */
  returnedNotPickedUp: number;
  /** Prepaid orders: still waiting on the shelf for the customer. */
  toPickUp: number;
  /** Can still be returned (not counting returns waiting for approval). For LPG, only what is still to pick up. */
  returnable: number;
  /** In returns waiting for approval. */
  pendingReturn: number;
}

/** Completed claims about one sale, oldest first. */
export function claimsFor(saleId: string, claims: Claim[]): Claim[] {
  return claims.filter((c) => c.saleId === saleId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Each line of a sale with what was picked up, returned and is still to come. */
export function saleProgress(sale: Sale, claims: Claim[]): LineProgress[] {
  const mine = claimsFor(sale.id, claims);
  return sale.lines.map((line, index) => {
    const sum = (kind: Claim['kind'], status: Claim['status'], pick: (item: ClaimItem) => number) =>
      mine
        .filter((c) => c.kind === kind && c.status === status)
        .flatMap((c) => c.items.filter((item) => item.line === index))
        .reduce((total, item) => total + pick(item), 0);
    const pickedUp = sum('pickup', 'completed', (item) => item.qty);
    const returned = sum('return', 'completed', (item) => item.qty);
    const returnedNotPickedUp = sum('return', 'completed', (item) => item.notPickedUp ?? 0);
    const pendingReturn = sum('return', 'pending', (item) => item.qty);
    const lpg = hasLpg(line);
    const toPickUp = sale.prepaid && sale.status === 'completed' ? Math.max(0, line.qty - pickedUp - returnedNotPickedUp) : 0;
    return {
      line: index,
      name: line.name,
      qty: line.qty,
      lpg,
      pickedUp,
      returned,
      returnedNotPickedUp,
      toPickUp,
      returnable: sale.status !== 'completed' ? 0 : lpg ? toPickUp : Math.max(0, line.qty - returned),
      pendingReturn,
    };
  });
}

/** Prepaid orders with something still to pick up, the oldest first. */
export function ordersToPickUp(sales: Sale[], claims: Claim[]): Sale[] {
  return sales
    .filter((s) => s.prepaid && s.status === 'completed' && saleProgress(s, claims).some((p) => p.toPickUp > 0))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Returns and defective exchanges waiting for the owner, an admin or the branch manager. */
/** Returns and exchanges waiting for approval, oldest first; given an approver, only those at their branches. */
export function pendingClaims(claims: Claim[], approver?: User | null): Claim[] {
  return claims
    .filter((c) => c.status === 'pending' && (approver === undefined || worksAt(approver, c.locationId)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** How much of the sale's money has already gone back in completed returns. */
export function refundedSoFar(saleId: string, claims: Claim[]): Centavos {
  return claims
    .filter((c) => c.saleId === saleId && c.kind === 'return' && c.status === 'completed')
    .reduce((sum, c) => sum + (c.refund ?? 0), 0);
}

/** The stock `qty` of a sale line moves, as a pick up (signed as a sale) or a return (put back). */
function lineMovements(
  ctx: OpContext,
  user: User,
  sale: Sale,
  lineIndex: number,
  qty: number,
  type: MovementType,
  fields: { locationId: string; reason: string; now: string },
): StockMovement[] {
  if (qty <= 0) return [];
  const sign = type === 'RETURN_IN' ? -1 : 1;
  return lineUnits(sale.lines[lineIndex], qty).flatMap((unit) =>
    stockChanges(unit).map((change) => ({
      id: uuid(),
      type,
      productId: unit.productId,
      locationId: fields.locationId,
      condition: change.condition,
      qty: change.qty * sign,
      reason: fields.reason,
      saleId: sale.id,
      userId: user.id,
      deviceId: ctx.deviceId,
      occurredAt: fields.now,
      createdAt: fields.now,
      receivedAt: null,
    })),
  );
}

/** Refuses movements that would take more than the shelf has (unless negative stock is allowed). */
async function checkStock(ctx: OpContext, movements: StockMovement[], locationId: string): Promise<void> {
  if (ALLOW_NEGATIVE_STOCK) return;
  const [all, products] = await Promise.all([ctx.store.list<StockMovement>('movements'), ctx.store.list<Product>('products')]);
  const levels = stockByProduct(all, locationId);
  const needs = new Map<string, number>();
  for (const m of movements) {
    if (m.qty >= 0) continue;
    const key = `${m.productId}:${m.condition}`;
    needs.set(key, (needs.get(key) ?? 0) - m.qty);
  }
  const shortages: Shortage[] = [];
  for (const [key, needed] of needs) {
    const [productId, condition] = key.split(':') as [string, StockCondition];
    const available = levelOf(levels, productId)[condition];
    if (available < needed) {
      const product = products.find((p) => p.id === productId);
      const name = `${product?.name ?? 'A product'}${condition === 'empty' ? ' empty cylinders' : condition === 'defective' ? ' (defective)' : ''}`;
      shortages.push({ productId, condition, name, available, needed });
    }
  }
  if (shortages.length > 0) throw new StockError(shortages);
}

async function saleFor(ctx: OpContext, saleId: string | undefined): Promise<Sale> {
  const sale = saleId ? await ctx.store.get<Sale>('sales', saleId) : null;
  if (!sale) throw new Error('That sale is no longer in the records.');
  return sale;
}

/** Cleans up the lines and quantities picked, dropping zeros and refusing anything that isn't on the sale. */
function claimItems(sale: Sale, items: { line: number; qty: number }[]): ClaimItem[] {
  const picked = items.filter((item) => item.qty > 0);
  if (picked.length === 0) throw new Error('Choose at least one item and how many.');
  return picked.map((item) => {
    const line = sale.lines[item.line];
    if (!line || !Number.isInteger(item.qty)) throw new Error('One of the items is not on this sale.');
    return { line: item.line, name: line.name, qty: item.qty };
  });
}

const now = (ctx: OpContext) => (ctx.now?.() ?? new Date()).toISOString();

const base = (ctx: OpContext, user: User, kind: Claim['kind'], at: string) => ({
  id: uuid(),
  kind,
  locationId: ctx.locationId,
  requestedBy: user.id,
  deviceId: ctx.deviceId,
  createdAt: at,
  receivedAt: null,
});

export interface PickupInput {
  saleId: string;
  items: { line: number; qty: number }[];
  /** The code printed on the prepaid receipt. The owner, admins and branch managers may leave it out (a lost receipt). */
  claimCode: string;
}

/** Hands over all or part of a prepaid order: the stock leaves the shelf here, now. Cashiers can do this. */
export async function recordPickup(ctx: OpContext, input: PickupInput): Promise<Claim> {
  const user = ctx.user;
  assertCan(user, 'pos.sell');
  const sale = await saleFor(ctx, input.saleId);
  if (!sale.prepaid) throw new Error('This sale was not prepaid; its items were handed over when it was sold.');
  if (sale.status !== 'completed') throw new Error('This order was voided, so there is nothing to pick up.');
  const code = input.claimCode.trim().toUpperCase();
  if (!code && !can(user, 'claims.approve')) {
    throw new Error("Enter the claim code from the customer's receipt. If the receipt is lost, ask the owner, an admin or the branch manager to release the order.");
  }
  if (code && code !== sale.claimCode) throw new Error("That claim code doesn't match this order. Check the customer's receipt.");

  const claims = await ctx.store.list<Claim>('claims');
  const progress = saleProgress(sale, claims);
  const items = claimItems(sale, input.items);
  for (const item of items) {
    const left = progress[item.line].toPickUp;
    if (item.qty > left) throw new Error(`Only ${left} of ${item.name} ${left === 1 ? 'is' : 'are'} left to pick up.`);
  }

  const at = now(ctx);
  const reason = `Prepaid pick up: ${sale.borrowerName ?? sale.receiptNo}`;
  const movements = items.flatMap((item) =>
    lineMovements(ctx, user, sale, item.line, item.qty, 'PICKUP', { locationId: ctx.locationId, reason, now: at }),
  );
  await checkStock(ctx, movements, ctx.locationId);

  const claim: Claim = {
    ...base(ctx, user, 'pickup', at),
    status: 'completed',
    saleId: sale.id,
    receiptNo: sale.receiptNo,
    ...(sale.borrowerId ? { customerId: sale.borrowerId, customerName: sale.borrowerName } : {}),
    items,
  };
  await ctx.store.batch([...saveAndQueue('claims', [claim], at), ...saveAndQueue('movements', movements, at)]);
  return claim;
}

export interface ReturnInput {
  saleId: string;
  items: { line: number; qty: number }[];
  /** How the money goes back. Ignored for sales on account, which come off the customer's account. */
  refundMethod: Exclude<PaymentMethod, 'credit' | 'cheque'>;
  reason: string;
}

/** What a return gives back: each line's share of what was paid, or everything left when it returns the whole sale. */
export function returnRefund(sale: Sale, claims: Claim[], items: { line: number; qty: number }[]): { refund: Centavos; voidsSale: boolean } {
  const progress = saleProgress(sale, claims);
  // Only when nothing at all is left with the customer or on the shelf (LPG they took can't come back).
  const voidsSale = progress.every((p) => p.qty - p.returned - (items.find((i) => i.line === p.line)?.qty ?? 0) <= 0);
  if (voidsSale) return { refund: sale.total - refundedSoFar(sale.id, claims), voidsSale };
  const refund = items.reduce((sum, item) => {
    const line = sale.lines[item.line];
    return line ? sum + Math.round((line.amount * item.qty) / line.qty) : sum;
  }, 0);
  return { refund, voidsSale };
}

/** LPG the customer took with them, which keeps a sale on account or that lent a cylinder from being returned. */
function lpgTaken(progress: LineProgress[]): boolean {
  return progress.some((p) => p.lpg && p.qty - p.returned - p.toPickUp > 0);
}

/**
 * Whether anything on the sale can still be returned: something other than LPG
 * (or LPG still waiting to be picked up) that isn't returned or waiting for
 * approval, on a sale that can be returned in part.
 */
export function canReturnFrom(sale: Sale, claims: Claim[]): boolean {
  if (sale.status !== 'completed') return false;
  const progress = saleProgress(sale, claims);
  if (isBorrowingSale(sale) && lpgTaken(progress)) return false;
  return progress.some((p) => p.returnable - p.pendingReturn > 0);
}

export const LPG_NOT_RETURNABLE = "LPG can't be returned once the customer has it.";

/**
 * A customer brings items back. A cashier's return waits for the owner, an
 * admin or the branch manager to approve it; theirs is completed straight away.
 * Returning everything that is left voids the sale. Sales on account or that
 * lent a cylinder can only be returned whole. LPG can't be returned, except a
 * prepaid order's LPG that hasn't been picked up.
 */
export async function requestReturn(ctx: OpContext, input: ReturnInput): Promise<Claim> {
  const user = ctx.user;
  assertCan(user, 'pos.sell');
  const sale = await saleFor(ctx, input.saleId);
  if (sale.status !== 'completed') throw new Error('This sale was voided, so nothing on it can be returned.');
  const reason = input.reason.trim();
  if (reason.length < 5) throw new Error('Say why it is being returned (at least 5 characters).');

  const claims = await ctx.store.list<Claim>('claims');
  const progress = saleProgress(sale, claims);
  const items = claimItems(sale, input.items);
  for (const item of items) {
    const p = progress[item.line];
    const left = p.returnable - p.pendingReturn;
    if (p.lpg && item.qty > left) {
      throw new Error(
        left > 0
          ? `${LPG_NOT_RETURNABLE} Only ${left} of ${item.name}, not picked up yet, can be returned.`
          : `${LPG_NOT_RETURNABLE} ${item.name} can't be returned.`,
      );
    }
    if (item.qty > left) {
      throw new Error(
        p.pendingReturn > 0
          ? `Only ${left} more of ${item.name} can be returned; ${p.pendingReturn} ${p.pendingReturn === 1 ? 'is' : 'are'} already waiting for approval.`
          : `Only ${left} of ${item.name} can be returned.`,
      );
    }
  }
  const { refund, voidsSale } = returnRefund(sale, claims, items);
  if (isBorrowingSale(sale) && lpgTaken(progress)) {
    throw new Error(
      "This sale was on account or lent a cylinder, so it can only be returned whole, but LPG can't be returned once the customer has it. If the sale was a mistake, the owner, an admin or the branch manager can void it.",
    );
  }
  if (isBorrowingSale(sale) && !voidsSale) {
    throw new Error('This sale was on account or lent a cylinder, so it can only be returned whole. Choose every item.');
  }

  const at = now(ctx);
  const claim: Claim = {
    ...base(ctx, user, 'return', at),
    status: 'pending',
    saleId: sale.id,
    receiptNo: sale.receiptNo,
    ...(sale.borrowerId ? { customerId: sale.borrowerId, customerName: sale.borrowerName } : {}),
    items,
    refund,
    refundMethod: sale.payment.method === 'credit' ? 'credit' : input.refundMethod,
    voidsSale,
    reason,
  };
  if (can(user, 'claims.approve')) return completeClaim(ctx, user, claim, at);
  await ctx.store.batch(saveAndQueue('claims', [claim], at));
  return claim;
}

export interface DefectiveInput {
  /** Optional: an exchange can be recorded without the customer's name. */
  customer?: CustomerRef | null;
  productId: string;
  /** Cylinders: how many kilos of gas the defective one lost (its size less what it still weighs in gas). */
  lostKg?: number;
  /** Accessories: what the customer pays for the exchange, if anything. Usually nothing. */
  charge?: Centavos;
  chargeMethod: Exclude<PaymentMethod, 'credit' | 'cheque'>;
  reason: string;
  /** The sale it came from, if the customer has the receipt. */
  saleId?: string;
}

/** The price of one kilo of a cylinder's gas: its refill price over its size. */
export function pricePerKg(product: Pick<Product, 'refillPrice' | 'price' | 'sizeKg'>): Centavos {
  if (!product.sizeKg) return 0;
  return Math.round((product.refillPrice ?? product.price) / product.sizeKg);
}

/** What the customer pays for the gas a defective cylinder lost. */
export function defectiveCharge(product: Pick<Product, 'refillPrice' | 'price' | 'sizeKg'>, lostKg: number): Centavos {
  if (!product.sizeKg || lostKg <= 0) return 0;
  return Math.round(((product.refillPrice ?? product.price) * lostKg) / product.sizeKg);
}

/** What was exchanged: "11 kg LPG, lost 1.5 kg" for a cylinder, or just the accessory's name. */
export function defectiveItemText(claim: Pick<Claim, 'productName' | 'lostKg'>): string {
  return claim.lostKg !== undefined ? `${claim.productName ?? ''}, lost ${claim.lostKg} kg` : (claim.productName ?? '');
}

/** "₱120.00 (1.5 kg × ₱80.00)" for a cylinder, "₱100.00" or "Free" for an accessory. */
export function defectiveChargeText(claim: Pick<Claim, 'charge' | 'lostKg' | 'pricePerKg'>): string {
  const charge = claim.charge ?? 0;
  if (claim.lostKg !== undefined) return `${formatPeso(charge)} (${claim.lostKg} kg × ${formatPeso(claim.pricePerKg ?? 0)})`;
  return charge > 0 ? formatPeso(charge) : 'Free';
}

/**
 * A customer swaps a defective cylinder for a new full one and pays only for the
 * gas it lost, or a defective accessory for a new one (usually free). The
 * defective one is counted on its own until it goes back to the depot. A
 * cashier's exchange waits for the owner, an admin or the branch manager to approve it.
 */
export async function requestDefective(ctx: OpContext, input: DefectiveInput): Promise<Claim> {
  const user = ctx.user;
  assertCan(user, 'pos.sell');
  const product = await ctx.store.get<Product>('products', input.productId);
  if (!product) throw new Error('Choose the cylinder or accessory being exchanged.');
  const cylinder = product.kind === 'cylinder';
  let lostKg: number | undefined;
  let charge: Centavos;
  if (cylinder) {
    if (!product.sizeKg) throw new Error(`Set the size of ${product.name} in Products first.`);
    lostKg = input.lostKg ?? NaN;
    if (!Number.isFinite(lostKg) || lostKg < 0 || lostKg > product.sizeKg) throw new Error(`Enter the gas it lost, from 0 to ${product.sizeKg} kg.`);
    charge = defectiveCharge(product, lostKg);
  } else {
    charge = input.charge ?? 0;
    if (!Number.isInteger(charge) || charge < 0 || charge > product.price) {
      throw new Error(`Enter a charge from ₱0 to ${formatPeso(product.price)}, or leave it blank.`);
    }
  }
  const reason = input.reason.trim();
  if (reason.length < 5) throw new Error(`Say what is wrong with the ${cylinder ? 'cylinder' : 'item'} (at least 5 characters).`);
  const sale = input.saleId ? await ctx.store.get<Sale>('sales', input.saleId) : null;

  const at = now(ctx);
  // Without a name, the customer on the receipt, if it has one.
  const named = input.customer ? await resolveCustomer(ctx, input.customer, at) : null;
  const customer = named?.customer ?? (sale?.borrowerId ? { id: sale.borrowerId, name: sale.borrowerName ?? '' } : null);
  const claim: Claim = {
    ...base(ctx, user, 'defective', at),
    status: 'pending',
    ...(sale ? { saleId: sale.id, receiptNo: sale.receiptNo } : {}),
    ...(customer ? { customerId: customer.id, customerName: customer.name } : {}),
    items: [],
    productId: product.id,
    productName: product.name,
    ...(cylinder ? { lostKg, pricePerKg: pricePerKg(product) } : {}),
    charge,
    chargeMethod: input.chargeMethod,
    reason,
  };
  const customerOps: StoreOp[] = named?.isNew ? saveAndQueue('borrowers', [named.customer], at) : [];
  if (can(user, 'claims.approve')) return completeClaim(ctx, user, claim, at, customerOps);
  await ctx.store.batch([...customerOps, ...saveAndQueue('claims', [claim], at)]);
  return claim;
}

/** Records what a return or defective exchange does to stock and money, and marks it completed by `user`. */
async function completeClaim(ctx: OpContext, user: User, claim: Claim, at: string, extra: StoreOp[] = []): Promise<Claim> {
  const decided = { decidedBy: user.id, decidedAt: at };
  const where = { locationId: claim.locationId, now: at };

  if (claim.kind === 'return') {
    const sale = await saleFor(ctx, claim.saleId);
    if (sale.status !== 'completed') throw new Error('This sale was voided since the return was asked for, so there is nothing left to return.');
    const claims = (await ctx.store.list<Claim>('claims')).filter((c) => c.id !== claim.id);
    const progress = saleProgress(sale, claims);
    for (const item of claim.items) {
      const p = progress[item.line];
      if (p && p.lpg && item.qty > p.returnable) {
        throw new Error(`${LPG_NOT_RETURNABLE} ${item.name} ${p.pickedUp > 0 ? 'was picked up since this was asked for' : "can't be returned"}, so reject this request.`);
      }
      if (item.qty > (p?.returnable ?? 0)) throw new Error(`${item.name} has already been returned since this was asked for.`);
    }
    // Worked out again now: pick ups or other returns may have happened since it was asked for.
    const { refund, voidsSale } = returnRefund(sale, claims, claim.items);
    const reason = `Returned: ${claim.reason ?? ''}`.trim();
    if (voidsSale) {
      const completed: Claim = { ...claim, ...decided, status: 'completed', refund, voidsSale, receivedAt: null };
      const { ops } = await voidSaleOps(ctx, user, sale, reason, at);
      await ctx.store.batch([...extra, ...ops, ...saveAndQueue('claims', [completed], at)]);
      return completed;
    }
    // Items not picked up yet (prepaid orders) are returned first; no stock comes back for them.
    const items = claim.items.map((item) => ({ ...item, notPickedUp: Math.min(item.qty, progress[item.line].toPickUp) }));
    const movements = items.flatMap((item) =>
      lineMovements(ctx, user, sale, item.line, item.qty - (item.notPickedUp ?? 0), 'RETURN_IN', { ...where, reason }),
    );
    await checkStock(ctx, movements, claim.locationId);
    const completed: Claim = { ...claim, ...decided, status: 'completed', items, refund, voidsSale, receivedAt: null };
    await ctx.store.batch([...extra, ...saveAndQueue('movements', movements, at), ...saveAndQueue('claims', [completed], at)]);
    return completed;
  }

  if (claim.kind === 'defective') {
    const product = claim.productId ? await ctx.store.get<Product>('products', claim.productId) : null;
    if (!product) throw new Error('That product no longer exists.');
    const reason = `Defective from ${claim.customerName ?? 'a customer'}: return it to the depot`;
    const movement = (condition: StockCondition, qty: number): StockMovement => ({
      id: uuid(),
      type: 'DEFECTIVE_EXCHANGE',
      productId: product.id,
      locationId: claim.locationId,
      condition,
      qty,
      reason,
      ...(claim.saleId ? { saleId: claim.saleId } : {}),
      userId: user.id,
      deviceId: ctx.deviceId,
      occurredAt: at,
      createdAt: at,
      receivedAt: null,
    });
    // A new full cylinder (or a new accessory) goes to the customer; the defective one is counted on its own until
    // it goes back to the depot.
    const movements = [movement(product.kind === 'cylinder' ? 'full' : 'unit', -1), movement('defective', 1)];
    await checkStock(ctx, movements, claim.locationId);
    const completed: Claim = { ...claim, ...decided, status: 'completed', receivedAt: null };
    await ctx.store.batch([...extra, ...saveAndQueue('movements', movements, at), ...saveAndQueue('claims', [completed], at)]);
    return completed;
  }

  throw new Error('Pick ups do not need approval.');
}

/** The owner, an admin or the branch manager approves a waiting return or defective exchange, which records it. */
export async function approveClaim(ctx: OpContext, claimId: string, note = ''): Promise<Claim> {
  const user = ctx.user;
  assertCan(user, 'claims.approve');
  const claim = await ctx.store.get<Claim>('claims', claimId);
  if (!claim) throw new Error('That request is no longer in the records.');
  if (claim.status !== 'pending') throw new Error(`That request was already ${claim.status === 'completed' ? 'approved' : 'rejected'}.`);
  assertWorksAt(user, claim.locationId);
  const at = now(ctx);
  return completeClaim(ctx, user, { ...claim, ...(note.trim() ? { decisionNote: note.trim() } : {}) }, at);
}

/** The owner, an admin or the branch manager turns down a waiting return or defective exchange. Nothing changes but its status. */
export async function rejectClaim(ctx: OpContext, claimId: string, note: string): Promise<Claim> {
  const user = ctx.user;
  assertCan(user, 'claims.approve');
  const claim = await ctx.store.get<Claim>('claims', claimId);
  if (!claim) throw new Error('That request is no longer in the records.');
  if (claim.status !== 'pending') throw new Error(`That request was already ${claim.status === 'completed' ? 'approved' : 'rejected'}.`);
  assertWorksAt(user, claim.locationId);
  if (note.trim().length < 3) throw new Error('Say why it is rejected, so the cashier can tell the customer.');
  const at = now(ctx);
  const rejected: Claim = { ...claim, status: 'rejected', decidedBy: user.id, decidedAt: at, decisionNote: note.trim(), receivedAt: null };
  await ctx.store.batch(saveAndQueue('claims', [rejected], at));
  return rejected;
}

/** A branch manager decides only for the branches they are assigned to. */
function assertWorksAt(user: User, locationId: string): void {
  if (!worksAt(user, locationId)) throw new Error("This request is from a branch you aren't assigned to, so its manager, an admin or the owner decides it.");
}

/** Whether this person approves returns and defective exchanges (the owner, admins and branch managers). */
export const approvesClaims = (user: Parameters<typeof can>[0]) => can(user, 'claims.approve');

/** Customers that a claim is about, for the customer report. */
export function claimCustomer(claim: Claim): Pick<Customer, 'id' | 'name'> | null {
  return claim.customerId ? { id: claim.customerId, name: claim.customerName ?? '' } : null;
}

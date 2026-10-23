import { describe, expect, it } from 'vitest';

import { localDay } from './dates';
import { DEMO_USERS, seedDemoData } from './demo';
import { levelOf, stockByProduct } from './ledger';
import type { StockMovement, User } from './models';
import { recordMovement, StockError, type OpContext } from './operations';
import { can, GRANTABLE_PERMISSIONS, PermissionError } from './roles';
import { MemoryStore, ObservableStore } from './store';
import { acceptedId, acceptTransfer, openTransfers, settleTransfer, transfers, transfersToAccept } from './transfers';
import { movementFormSchema } from './validation';

const [owner, cashier, warehouse, admin, manager] = DEMO_USERS as [User, User, User, User, User];
const branch2Manager: User = { ...manager, id: 'u-manager-2', displayName: 'Branch 2 manager', locationIds: ['branch-2'] };

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User, locationId: string): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId });
  const movements = () => store.list<StockMovement>('movements');
  const stock = async (locationId: string, productId: string) => levelOf(stockByProduct(await movements(), locationId), productId);
  const send = (from: OpContext, to: string, productId: string, qty: number, condition: 'full' | 'empty' | 'unit' | 'defective' = 'full') =>
    recordMovement(from, { type: 'TRANSFER_OUT', productId, condition, direction: 'add', qty, reason: '', day: localDay(new Date()), counterpartLocationId: to }).then(
      ([m]) => m!,
    );
  return { store, ctx, movements, stock, send };
}

describe('stock sent between branches', () => {
  it('leaves the sender now, and waits at the receiving branch until its manager or warehouse staff accepts it', async () => {
    const { ctx, movements, stock, send } = await setup();
    const warehouseBefore = await stock('warehouse', 'lpg-a-11');
    const mainBefore = await stock('branch-main', 'lpg-a-11');
    const sent = await send(ctx(warehouse, 'warehouse'), 'branch-main', 'lpg-a-11', 10);

    expect(await stock('warehouse', 'lpg-a-11')).toEqual({ ...warehouseBefore, full: warehouseBefore.full - 10 });
    expect(await stock('branch-main', 'lpg-a-11')).toEqual(mainBefore);
    expect(transfers(await movements()).find((t) => t.id === sent.id)).toMatchObject({ state: 'on-the-way', fromId: 'warehouse', toId: 'branch-main', qty: 10 });
    // It shows at both ends, but only the receiving branch's approvers can accept it.
    expect(openTransfers(await movements(), 'warehouse').map((t) => t.id)).toContain(sent.id);
    expect(transfersToAccept(await movements(), manager, 'branch-main').map((t) => t.id)).toContain(sent.id);
    expect(transfersToAccept(await movements(), cashier, 'branch-main')).toEqual([]);
    expect(transfersToAccept(await movements(), warehouse, 'branch-main')).toEqual([]);

    await expect(acceptTransfer(ctx(cashier, 'branch-main'), sent.id, 10)).rejects.toThrow(PermissionError);
    // It comes only with the role, so it can't be given to a cashier as an extra.
    const granted: User = { ...cashier, extraPermissions: ['inventory.receive'] };
    await expect(acceptTransfer(ctx(granted, 'branch-main'), sent.id, 10)).rejects.toThrow(PermissionError);
    await expect(acceptTransfer(ctx(branch2Manager, 'branch-2'), sent.id, 10)).rejects.toThrow('going to Main Branch');
    await expect(acceptTransfer(ctx(warehouse, 'warehouse'), sent.id, 10)).rejects.toThrow('going to Main Branch');

    const accepted = await acceptTransfer(ctx(manager, 'branch-main'), sent.id, 10);
    expect(accepted).toMatchObject({ state: 'accepted', arrived: 10, difference: 0 });
    expect(accepted.accepted).toMatchObject({ id: acceptedId(sent.id), type: 'TRANSFER_IN', locationId: 'branch-main', counterpartLocationId: 'warehouse', userId: manager.id });
    expect(await stock('branch-main', 'lpg-a-11')).toEqual({ ...mainBefore, full: mainBefore.full + 10 });
    expect(openTransfers(await movements(), 'branch-main').map((t) => t.id)).not.toContain(sent.id);
    await expect(acceptTransfer(ctx(owner, 'branch-main'), sent.id, 10)).rejects.toThrow('already accepted');
  });

  it('starts the demo with stock on its way to the main branch, and a short count for the warehouse to settle', async () => {
    const { movements } = await setup();
    expect(transfersToAccept(await movements(), manager, 'branch-main').map((t) => [t.productId, t.qty])).toEqual([['lpg-a-11', 20]]);
    expect(openTransfers(await movements(), 'warehouse').map((t) => [t.state, t.toId, t.difference])).toEqual([
      ['on-the-way', 'branch-main', 0],
      ['mismatch', 'branch-2', 1],
    ]);
  });

  it('lets the owner, admins, branch managers and warehouse staff accept stock, and no one else', () => {
    expect([owner, admin, manager, warehouse].every((u) => can(u, 'inventory.receive'))).toBe(true);
    expect(can(cashier, 'inventory.receive')).toBe(false);
    expect(GRANTABLE_PERMISSIONS).not.toContain('inventory.receive');
  });

  it('takes Stocks In off the list of movements recorded by hand', () => {
    const form = { productId: 'lpg-a-11', condition: 'full', direction: 'add', qty: '1', reason: '', day: localDay(new Date()), counterpartLocationId: 'warehouse' };
    expect(movementFormSchema.safeParse({ ...form, type: 'TRANSFER_IN' }).success).toBe(false);
    expect(movementFormSchema.safeParse({ ...form, type: 'TRANSFER_OUT' }).success).toBe(true);
  });

  it('needs a note when the count differs, and waits for the sending branch to settle it', async () => {
    const { ctx, movements, stock, send } = await setup();
    const mainBefore = await stock('branch-main', 'acc-hose');
    const sent = await send(ctx(manager, 'branch-main'), 'branch-2', 'acc-hose', 6, 'unit');

    await expect(acceptTransfer(ctx(branch2Manager, 'branch-2'), sent.id, 5)).rejects.toThrow('Say what was different');
    const short = await acceptTransfer(ctx(branch2Manager, 'branch-2'), sent.id, 5, 'One hose missing from the box');
    expect(short).toMatchObject({ state: 'mismatch', arrived: 5, difference: 1 });
    expect((await stock('branch-2', 'acc-hose')).unit).toBe(8 + 5);
    expect(openTransfers(await movements(), 'branch-main').map((t) => t.id)).toContain(sent.id);

    // The sending branch settles it, after checking its own shelf.
    await expect(settleTransfer(ctx(branch2Manager, 'branch-2'), sent.id, 'fix-count', 'Found it')).rejects.toThrow('sent from Main Branch');
    await expect(settleTransfer(ctx(cashier, 'branch-main'), sent.id, 'fix-count', 'Found it')).rejects.toThrow(PermissionError);
    await expect(settleTransfer(ctx(manager, 'branch-main'), sent.id, 'fix-count', '')).rejects.toThrow('Say what you found');
    const settled = await settleTransfer(ctx(manager, 'branch-main'), sent.id, 'fix-count', 'It was still under the counter');
    expect(settled.state).toBe('settled');
    expect(settled.settled).toMatchObject({ type: 'TRANSFER_FIX', locationId: 'branch-main', qty: 1, reason: '1 never left. It was still under the counter' });
    // Only the 5 that arrived left the main branch in the end.
    expect((await stock('branch-main', 'acc-hose')).unit).toBe(mainBefore.unit - 5);
    expect(openTransfers(await movements(), 'branch-main').map((t) => t.id)).not.toContain(sent.id);
    await expect(settleTransfer(ctx(owner, 'branch-main'), sent.id, 'leave', 'Again')).rejects.toThrow('already settled');
  });

  it('can write off what was lost on the way, leaving both counts as they are', async () => {
    const { ctx, stock, send } = await setup();
    const sent = await send(ctx(owner, 'branch-main'), 'warehouse', 'lpg-a-11', 3, 'empty');
    await acceptTransfer(ctx(warehouse, 'warehouse'), sent.id, 2, 'One fell off the truck');
    const before = await stock('branch-main', 'lpg-a-11');
    const settled = await settleTransfer(ctx(owner, 'branch-main'), sent.id, 'leave', 'Driver confirmed it dented and was thrown away');
    expect(settled.settled).toMatchObject({ qty: 0, reason: '1 lost on the way. Driver confirmed it dented and was thrown away' });
    expect(await stock('branch-main', 'lpg-a-11')).toEqual(before);
  });

  it('takes more off the sender when more arrived than it recorded, if it has them', async () => {
    const { ctx, stock, send } = await setup();
    const regulators = await send(ctx(warehouse, 'warehouse'), 'branch-2', 'acc-regulator', 2, 'unit');
    await acceptTransfer(ctx(branch2Manager, 'branch-2'), regulators.id, 3, 'Three in the box');
    const before = (await stock('warehouse', 'acc-regulator')).unit;
    const fixed = await settleTransfer(ctx(warehouse, 'warehouse'), regulators.id, 'fix-count', 'Packed one more than written');
    expect(fixed.settled).toMatchObject({ qty: -1, reason: '1 more sent than recorded. Packed one more than written' });
    expect((await stock('warehouse', 'acc-regulator')).unit).toBe(before - 1);

    // Every stove the warehouse had went out, so it has none left to take off.
    const stoves = (await stock('warehouse', 'acc-stove')).unit;
    const all = await send(ctx(warehouse, 'warehouse'), 'branch-2', 'acc-stove', stoves, 'unit');
    await acceptTransfer(ctx(branch2Manager, 'branch-2'), all.id, stoves + 1, 'One extra stove');
    await expect(settleTransfer(ctx(warehouse, 'warehouse'), all.id, 'fix-count', 'Packed one more')).rejects.toThrow(StockError);
    const kept = await settleTransfer(ctx(warehouse, 'warehouse'), all.id, 'leave', 'Not ours; Branch 2 keeps it');
    expect(kept.settled).toMatchObject({ qty: 0, reason: '1 extra kept where it arrived. Not ours; Branch 2 keeps it' });
  });

  it('lets nothing arrive, and sends defective stock on to the warehouse like any other', async () => {
    const { ctx, stock, send } = await setup();
    const none = await send(ctx(owner, 'branch-main'), 'branch-2', 'lpg-b-11', 1);
    expect(await acceptTransfer(ctx(owner, 'branch-2'), none.id, 0, 'Never came')).toMatchObject({ state: 'mismatch', arrived: 0, difference: 1 });
    await expect(acceptTransfer(ctx(owner, 'branch-2'), none.id, 0.5)).rejects.toThrow();

    await recordMovement(ctx(owner, 'branch-main'), {
      type: 'DAMAGED',
      productId: 'lpg-a-11',
      condition: 'empty',
      direction: 'add',
      qty: 1,
      reason: 'Bent valve',
      day: localDay(new Date()),
      counterpartLocationId: '',
    });
    const defective = await send(ctx(owner, 'branch-main'), 'warehouse', 'lpg-a-11', 1, 'defective');
    await acceptTransfer(ctx(warehouse, 'warehouse'), defective.id, 1);
    expect((await stock('warehouse', 'lpg-a-11')).defective).toBe(1);
    expect((await stock('branch-main', 'lpg-a-11')).defective).toBe(0);
  });
});

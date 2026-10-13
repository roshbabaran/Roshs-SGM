import type { ISODate, MovementType, Product, StockMovement } from './models';

export interface StockLevel {
  full: number;
  empty: number;
  unit: number;
}

export const NO_STOCK: StockLevel = { full: 0, empty: 0, unit: 0 };

/** Adds up every movement at one branch or warehouse into stock per product. */
export function stockByProduct(movements: StockMovement[], locationId: string): Map<string, StockLevel> {
  const levels = new Map<string, StockLevel>();
  for (const movement of movements) {
    if (movement.locationId !== locationId) continue;
    const level = levels.get(movement.productId) ?? { ...NO_STOCK };
    level[movement.condition] += movement.qty;
    levels.set(movement.productId, level);
  }
  return levels;
}

/** Stock at one branch or warehouse just before a moment, counting movements by when they happened. */
export function stockBefore(movements: StockMovement[], locationId: string, before: string): Map<string, StockLevel> {
  return stockByProduct(
    movements.filter((m) => m.occurredAt < before),
    locationId,
  );
}

export interface LevelChange {
  before: StockLevel;
  after: StockLevel;
}

/**
 * One line of movement history: what one sale, void or entry did to one product,
 * with a cylinder's full and empty counts together.
 */
export interface MovementRow extends LevelChange {
  /** The first movement's id. */
  id: string;
  type: MovementType;
  productId: string;
  saleId?: string;
  reason?: string;
  userId: string;
  occurredAt: ISODate;
  createdAt: ISODate;
  /** What it added (positive) or took away (negative). */
  change: StockLevel;
  /** True once the server has every movement in the row. */
  synced: boolean;
  movements: StockMovement[];
}

/** A refill's empty coming in goes on the same line as the full going out. */
const rowType = (type: MovementType): MovementType => (type === 'EMPTY_IN' ? 'SALE' : type);

const plus = (level: StockLevel, movement: StockMovement): StockLevel => ({
  ...level,
  [movement.condition]: level[movement.condition] + movement.qty,
});

/**
 * Movement history at one branch or warehouse, oldest first. The movements that
 * one sale, void or entry made to a product share a row, which carries that
 * product's stock just before and just after it.
 */
export function movementRows(movements: StockMovement[], locationId: string): MovementRow[] {
  const rows = new Map<string, MovementRow & { index: number }>();
  movements.forEach((movement, index) => {
    if (movement.locationId !== locationId) return;
    const type = rowType(movement.type);
    const key = [
      movement.saleId ?? '',
      type,
      movement.productId,
      movement.occurredAt,
      movement.createdAt,
      movement.userId,
      movement.deviceId,
      movement.reason ?? '',
    ].join('\n');
    const row = rows.get(key);
    if (row) {
      row.change = plus(row.change, movement);
      row.synced &&= movement.receivedAt !== null;
      row.movements.push(movement);
      return;
    }
    rows.set(key, {
      index,
      id: movement.id,
      type,
      productId: movement.productId,
      saleId: movement.saleId,
      reason: movement.reason,
      userId: movement.userId,
      occurredAt: movement.occurredAt,
      createdAt: movement.createdAt,
      change: plus(NO_STOCK, movement),
      before: NO_STOCK,
      after: NO_STOCK,
      synced: movement.receivedAt !== null,
      movements: [movement],
    });
  });

  const running = new Map<string, StockLevel>();
  return [...rows.values()]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt) || a.index - b.index)
    .map(({ index: _index, ...row }) => {
      const before = running.get(row.productId) ?? NO_STOCK;
      const after = {
        full: before.full + row.change.full,
        empty: before.empty + row.change.empty,
        unit: before.unit + row.change.unit,
      };
      running.set(row.productId, after);
      return { ...row, before, after };
    });
}

export function levelOf(levels: Map<string, StockLevel>, productId: string): StockLevel {
  return levels.get(productId) ?? NO_STOCK;
}

/** What can be sold right now: full cylinders for cylinders, units for accessories. */
export function sellable(product: Product, level: StockLevel): number {
  return product.kind === 'cylinder' ? level.full : level.unit;
}

export function isLowStock(product: Product, level: StockLevel): boolean {
  return sellable(product, level) <= product.lowStockAt;
}

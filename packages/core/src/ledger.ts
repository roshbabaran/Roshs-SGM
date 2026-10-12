import type { Product, StockMovement } from './models';

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

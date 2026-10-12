import type { Centavos } from './money';
import type { Permission, Role } from './roles';

/** ISO 8601 timestamp, e.g. "2026-10-12T08:30:00.000Z". */
export type ISODate = string;

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** Extra permissions the owner granted on top of the role (the "flexible employee"). */
  extraPermissions?: Permission[];
  /** Branches or warehouses this person may work in. */
  locationIds: string[];
  active: boolean;
}

export type LocationKind = 'branch' | 'warehouse';

export interface Location {
  id: string;
  name: string;
  kind: LocationKind;
}

export type ProductKind = 'cylinder' | 'accessory';

export interface Product {
  id: string;
  sku: string;
  name: string;
  kind: ProductKind;
  brand?: string;
  sizeKg?: number;
  /** Cylinders only: price when the customer hands over an empty cylinder of the same kind. */
  refillPrice?: Centavos;
  /** Cylinders: price of a full cylinder with no empty in return. Accessories: unit price. */
  price: Centavos;
  /** Show a low-stock warning at or below this many sellable units. */
  lowStockAt: number;
  active: boolean;
}

/** Cylinders are counted full and empty separately; accessories are plain units. */
export type StockCondition = 'full' | 'empty' | 'unit';

export type MovementType =
  | 'OPENING'
  | 'DELIVERY_IN'
  | 'SALE'
  | 'EMPTY_IN'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'ADJUSTMENT'
  | 'DAMAGED'
  | 'RETURN_TO_SUPPLIER'
  | 'VOID_REVERSAL';

/**
 * Stock is never stored as a single number. Every change is a movement, and the
 * stock on hand is the sum of movements. Two offline devices can each record
 * sales and sync later without overwriting each other.
 */
export interface StockMovement {
  id: string;
  type: MovementType;
  productId: string;
  locationId: string;
  condition: StockCondition;
  /** Signed: positive adds stock, negative removes it. */
  qty: number;
  reason?: string;
  saleId?: string;
  /** For transfers: the other branch or warehouse. */
  counterpartLocationId?: string;
  userId: string;
  deviceId: string;
  /** When it physically happened (a delivery can be recorded the day after). */
  occurredAt: ISODate;
  /** The device's clock when this was recorded (can be wrong on offline devices). */
  createdAt: ISODate;
  /** The server's clock when it accepted this record; null until synced. */
  receivedAt: ISODate | null;
}

/** refill: empty in, full out. new: full cylinder sold with no empty in return. item: accessory. */
export type SaleLineType = 'refill' | 'new' | 'item';

export interface SaleLine {
  productId: string;
  name: string;
  type: SaleLineType;
  qty: number;
  unitPrice: Centavos;
  amount: Centavos;
}

export type PaymentMethod = 'cash' | 'gcash' | 'maya' | 'bank';

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  bank: 'Bank transfer',
};

export interface Payment {
  method: PaymentMethod;
  amount: Centavos;
  /** Cash handed over by the customer (equal to amount for e-wallets and bank). */
  tendered: Centavos;
  change: Centavos;
  /** E-wallet or bank reference number. */
  reference?: string;
}

export type SaleStatus = 'completed' | 'voided';

export interface Sale {
  id: string;
  receiptNo: string;
  locationId: string;
  deviceId: string;
  cashierId: string;
  lines: SaleLine[];
  total: Centavos;
  payment: Payment;
  status: SaleStatus;
  voidReason?: string;
  voidedBy?: string;
  voidedAt?: ISODate;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/** A change waiting to be sent to the server. */
export interface OutboxEntry {
  id: string;
  collection: 'sales' | 'movements';
  recordId: string;
  payload: Sale | StockMovement;
  createdAt: ISODate;
  attempts: number;
  /** Set when the server refused the change; it then needs a person to look at it. */
  rejectedReason?: string;
}

/** Small key/value settings kept in the local database. */
export interface MetaRecord<T = unknown> {
  id: string;
  value: T;
}

export interface DeviceSettings {
  locationId: string;
  paperWidthMm: 58 | 80;
  printerName?: string;
}

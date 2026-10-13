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
  /** Hidden products stay in the records but can't be sold. */
  active: boolean;
  /** When the server accepted the latest change made on this device; null until then. */
  receivedAt?: ISODate | null;
}

/** How a product appears in a set: as a refill, a new cylinder, or an accessory. */
export type SetItemType = 'refill' | 'new' | 'item';

export interface SetItem {
  productId: string;
  type: SetItemType;
  qty: number;
}

/** A bundle of products sold together, usually for less than buying them one by one. */
export interface ProductSet {
  id: string;
  name: string;
  items: SetItem[];
  price: Centavos;
  active: boolean;
  receivedAt?: ISODate | null;
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
  | 'CYLINDER_RETURN'
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

/**
 * How a product is sold:
 * - refill: the customer swaps an empty for a full cylinder
 * - new: a full cylinder with no empty in return (cylinder + content)
 * - borrow: a refill in a cylinder the customer borrows and brings back later
 * - item: an accessory
 */
export type ProductLineType = SetItemType | 'borrow';

export type SaleLineType = ProductLineType | 'set';

export interface ProductSaleLine {
  type: ProductLineType;
  productId: string;
  name: string;
  qty: number;
  unitPrice: Centavos;
  amount: Centavos;
  /** New cylinders: the content (gas) part of unitPrice. The rest is the price of the cylinder itself. */
  contentPrice?: Centavos;
}

export interface SetSaleItem extends SetItem {
  name: string;
}

export interface SetSaleLine {
  type: 'set';
  setId: string;
  name: string;
  qty: number;
  unitPrice: Centavos;
  amount: Centavos;
  /** What one set contained when it was sold. */
  items: SetSaleItem[];
}

export type SaleLine = ProductSaleLine | SetSaleLine;

/** 'credit' means "on account": the borrower pays later (Borrowing window only). */
export type PaymentMethod = 'cash' | 'gcash' | 'maya' | 'bank' | 'credit';

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  bank: 'Bank transfer',
  credit: 'On account',
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
  /** Sales made in the Borrowing window: who owes for it or borrowed a cylinder. */
  borrowerId?: string;
  borrowerName?: string;
  voidReason?: string;
  voidedBy?: string;
  voidedAt?: ISODate;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/** Someone who takes a refill on credit or borrows a cylinder. */
export interface Borrower {
  id: string;
  name: string;
  phone?: string;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/**
 * - credit: a refill (or a borrowed cylinder's refill) put on the borrower's account
 * - payment: money the borrower paid back
 * - cylinder_out / cylinder_return: a cylinder lent, or brought back
 * - void: cancels an entry of a voided sale
 */
export type LoanEntryKind = 'credit' | 'payment' | 'cylinder_out' | 'cylinder_return' | 'void';

/**
 * Borrowing is a ledger like stock: entries are only ever added. What someone
 * owes is the sum of `amount`, and the cylinders they have is the sum of `qty`
 * per product.
 */
export interface LoanEntry {
  id: string;
  kind: LoanEntryKind;
  borrowerId: string;
  /** The borrower's name at the time, so history reads right after a rename. */
  borrowerName: string;
  /** Signed: positive adds to what they owe, negative pays it down. */
  amount: Centavos;
  /** Cylinder entries: which cylinder, and how many (signed: lent positive, returned negative). */
  productId?: string;
  qty?: number;
  /** The sale that lent the cylinder or put the refill on account. */
  saleId?: string;
  /** Payments: how they paid. */
  payment?: Payment;
  /** void: the entry this cancels. */
  reverses?: string;
  note?: string;
  locationId: string;
  userId: string;
  deviceId: string;
  occurredAt: ISODate;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/** Collections this device sends to the server through the outbox. */
export type OutboxCollection = 'sales' | 'movements' | 'products' | 'sets' | 'borrowers' | 'loans';

export type OutboxRecord = Sale | StockMovement | Product | ProductSet | Borrower | LoanEntry;

/** A change waiting to be sent to the server. */
export interface OutboxEntry {
  id: string;
  collection: OutboxCollection;
  recordId: string;
  payload: OutboxRecord;
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

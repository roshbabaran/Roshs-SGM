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

/** Another set inside a set, e.g. a starter kit inside a kitchen set. */
export interface NestedSet {
  setId: string;
  qty: number;
}

/** A bundle of products sold together, usually for less than buying them one by one. */
export interface ProductSet {
  id: string;
  name: string;
  /** The products added to this set directly. */
  items: SetItem[];
  /** Other sets inside this one. At the counter they open up into their products (setContents in cart.ts). */
  sets?: NestedSet[];
  price: Centavos;
  active: boolean;
  receivedAt?: ISODate | null;
}

/**
 * Cylinders are counted full and empty separately; accessories are plain units.
 * Defective cylinders and accessories taken back from customers are counted on
 * their own until they go back to the depot, so they are never sold or refilled.
 */
export type StockCondition = 'full' | 'empty' | 'unit' | 'defective';

export const CONDITION_LABELS: Record<StockCondition, string> = {
  full: 'Full',
  empty: 'Empty',
  unit: 'In stock',
  defective: 'Defective',
};

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
  | 'VOID_REVERSAL'
  /** A prepaid order leaving the shelf when the customer picks it up. */
  | 'PICKUP'
  /** Items a customer brought back, once the owner, an admin or the branch manager approved the return. */
  | 'RETURN_IN'
  /** A new cylinder given for a defective one, which goes with the empties back to the depot. */
  | 'DEFECTIVE_EXCHANGE'
  /** The sending branch settling a Stocks Out that arrived with a different count (transfers.ts). */
  | 'TRANSFER_FIX';

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
  /**
   * Stocks Out that waits for the receiving branch to accept it, and the movements that accept and settle it:
   * the Stocks Out's own id (transfers.ts).
   */
  transferId?: string;
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

/** A lower price for one line: a percentage off, or a different price for each unit. */
export type Discount = { kind: 'percent'; percent: number } | { kind: 'price'; price: Centavos };

/** Where a line's discount came from: the customer's standing discount, or the cashier at the counter. */
export type DiscountSource = 'customer' | 'counter';

export type LineDiscount = Discount & { source: DiscountSource };

/** Fields a sale line has when it was sold for less than its regular price. */
interface Discounted {
  /** The regular price of one unit; unitPrice is what was charged after the discount. */
  regularPrice?: Centavos;
  discount?: LineDiscount;
}

export interface ProductSaleLine extends Discounted {
  type: ProductLineType;
  productId: string;
  name: string;
  qty: number;
  unitPrice: Centavos;
  amount: Centavos;
  /** New cylinders: the content (gas) part of the regular price. The rest is the price of the cylinder itself. */
  contentPrice?: Centavos;
}

export interface SetSaleItem extends SetItem {
  name: string;
}

export interface SetSaleLine extends Discounted {
  type: 'set';
  setId: string;
  name: string;
  qty: number;
  unitPrice: Centavos;
  amount: Centavos;
  /** What one set contained when it was sold, with any sets inside it opened up into their products. */
  items: SetSaleItem[];
}

export type SaleLine = ProductSaleLine | SetSaleLine;

/**
 * 'credit' means "on account": the borrower pays later. 'cheque' is a post-dated
 * cheque that can be cashed from a set day. Both are only taken in the Borrowing window.
 */
export type PaymentMethod = 'cash' | 'gcash' | 'maya' | 'bank' | 'cheque' | 'credit';

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  bank: 'Bank transfer',
  cheque: 'Post-dated cheque',
  credit: 'On account',
};

export interface Cheque {
  number: string;
  bank: string;
  /** The day it can be cashed ('YYYY-MM-DD'). */
  cashOn: string;
}

export interface Payment {
  method: PaymentMethod;
  amount: Centavos;
  /** Cash handed over by the customer (equal to amount for e-wallets, bank and cheques). */
  tendered: Centavos;
  change: Centavos;
  /** E-wallet or bank reference number. */
  reference?: string;
  /** Post-dated cheques: its number, bank and the day it can be cashed. */
  cheque?: Cheque;
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
  /** Sales on credit: what the customer paid when they took the items. The rest went on their account. */
  downPayment?: Payment;
  status: SaleStatus;
  /**
   * The customer the sale is for. Every Borrowing-window sale has one (who owes
   * for it or borrowed a cylinder); at the counter it is optional, except for
   * prepaid orders. The fields keep their 1.0 names so older records still read right.
   */
  borrowerId?: string;
  borrowerName?: string;
  /** Paid now, picked up later in the Claims window. Its stock leaves the shelf only when it is picked up. */
  prepaid?: boolean;
  /** Prepaid orders: the code printed on the receipt, asked for at pick up. */
  claimCode?: string;
  /** The number printed on the handwritten receipt the sale was scanned from. */
  slipNo?: string;
  voidReason?: string;
  voidedBy?: string;
  voidedAt?: ISODate;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/** A customer's standing discount, set by the owner on the Products page. */
export interface CustomerDiscount {
  /** Percentage off everything they buy, from 1 to 99. */
  percent?: number;
  /**
   * Their own price for particular things, which wins over the percentage. Keys
   * are discountKey() in customers.ts: "productId:refill", "productId:new",
   * "productId:item" or "set:setId".
   */
  prices?: Record<string, Centavos>;
}

/**
 * A named customer: picked or added when selling, on credit or when borrowing
 * a cylinder. Kept in the 'borrowers' collection, where 1.0 kept borrowers.
 */
export interface Customer {
  id: string;
  name: string;
  phone?: string;
  discount?: CustomerDiscount;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/** Someone who buys on credit or borrows a cylinder: a customer seen from the Borrowing window. */
export type Borrower = Customer;

/**
 * - credit: anything bought on the borrower's account (a refill, a borrowed cylinder's refill, other items)
 * - payment: money the borrower paid back (cash, e-wallet, bank or a post-dated cheque)
 * - cylinder_out / cylinder_return: a cylinder lent, or brought back
 * - void: cancels an entry of a voided sale
 * - cheque_cleared: a post-dated cheque was deposited and cleared (changes no amount)
 * - cheque_bounced: a post-dated cheque bounced, so its amount is owed again
 */
export type LoanEntryKind = 'credit' | 'payment' | 'cylinder_out' | 'cylinder_return' | 'void' | 'cheque_cleared' | 'cheque_bounced';

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
  /** void: the entry this cancels. cheque_cleared and cheque_bounced: the cheque's payment. */
  reverses?: string;
  note?: string;
  locationId: string;
  userId: string;
  deviceId: string;
  occurredAt: ISODate;
  createdAt: ISODate;
  receivedAt: ISODate | null;
}

/**
 * The Claims window's records:
 * - pickup: a prepaid order (or part of it) handed to the customer
 * - return: items a customer brings back for a refund
 * - defective: a defective cylinder swapped for a new one; the customer pays for the gas it lost
 */
export type ClaimKind = 'pickup' | 'return' | 'defective';

/**
 * Returns and defective exchanges made by a cashier wait as 'pending' until the
 * owner or an admin approves ('completed') or rejects them. Pick ups, and
 * anything the owner, an admin or the branch manager records, are completed straight away.
 */
export type ClaimStatus = 'pending' | 'completed' | 'rejected';

/** Some of one sale line: picked up, or returned. */
export interface ClaimItem {
  /** Index into the sale's lines. */
  line: number;
  name: string;
  qty: number;
  /** Returns of prepaid orders: how many of these had not been picked up, so no stock comes back for them. */
  notPickedUp?: number;
}

export interface Claim {
  id: string;
  kind: ClaimKind;
  status: ClaimStatus;
  /** The sale it is about (required for pick ups and returns). */
  saleId?: string;
  receiptNo?: string;
  customerId?: string;
  customerName?: string;
  /** Pick ups and returns: which lines of the sale, and how many. */
  items: ClaimItem[];
  /** Returns: what goes back to the customer, and how. A return of everything left voids the sale. */
  refund?: Centavos;
  refundMethod?: PaymentMethod;
  voidsSale?: boolean;
  /** Defective exchanges: the cylinder, how much gas it lost, and what that costs. */
  productId?: string;
  productName?: string;
  lostKg?: number;
  pricePerKg?: Centavos;
  charge?: Centavos;
  chargeMethod?: PaymentMethod;
  /** Why (returns and defectives). */
  reason?: string;
  locationId: string;
  requestedBy: string;
  deviceId: string;
  createdAt: ISODate;
  /** The owner, admin or branch manager who approved or rejected it, when, and what they said. */
  decidedBy?: string;
  decidedAt?: ISODate;
  decisionNote?: string;
  receivedAt: ISODate | null;
}

/** Collections this device sends to the server through the outbox. */
export type OutboxCollection = 'sales' | 'movements' | 'products' | 'sets' | 'borrowers' | 'loans' | 'claims';

export type OutboxRecord = Sale | StockMovement | Product | ProductSet | Customer | LoanEntry | Claim;

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

/** A PC or phone that has signed in, or that the owner added ahead of time (Users & Devices). */
export interface Device {
  id: string;
  label: string | null;
  approved: boolean;
  /** The branch or warehouse it is used at, for finding it in the list. */
  locationId: string | null;
  firstSeenAt: ISODate;
  lastSeenAt: ISODate | null;
  lastUserId: string | null;
}

export interface DeviceSettings {
  locationId: string;
  paperWidthMm: 58 | 80;
  printerName?: string;
}

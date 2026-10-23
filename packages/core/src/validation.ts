/**
 * Form rules shared by both apps. Forms hold what the person typed (strings);
 * each schema checks it and turns it into clean values.
 */
import { z } from 'zod';

import { localDay, isValidDay } from './dates';
import type { Discount, MovementType, NestedSet, Payment, PaymentMethod, ProductKind, SetItem } from './models';
import { formatPeso, parsePeso, type Centavos } from './money';

const group = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const wholeNumber = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${label} must be a whole number`)
    .transform((value) => parseInt(value, 10))
    .refine((n) => n >= min && n <= max, `${label} must be from ${group(min)} to ${group(max)}`);

export const loginFormSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username').max(40),
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits'),
});

/**
 * Stock changes a person records by hand (sales record their own movements). Stocks In isn't one: stock sent
 * from another branch comes in when the receiving branch accepts it (transfers.ts).
 */
export const MANUAL_MOVEMENT_TYPES = [
  'DELIVERY_IN',
  'TRANSFER_OUT',
  'ADJUSTMENT',
  'DAMAGED',
  'RETURN_TO_SUPPLIER',
] as const satisfies readonly MovementType[];

export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number];

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  OPENING: 'Opening stock',
  DELIVERY_IN: 'From Depot',
  SALE: 'Sale',
  EMPTY_IN: 'Empty received (refill)',
  TRANSFER_OUT: 'Stocks Out',
  TRANSFER_IN: 'Stocks In',
  ADJUSTMENT: 'Adjustment',
  DAMAGED: 'Defective',
  RETURN_TO_SUPPLIER: 'To Depot',
  CYLINDER_RETURN: 'Cylinder returned',
  VOID_REVERSAL: 'Voided sale',
  PICKUP: 'Prepaid pick up',
  RETURN_IN: 'Customer return',
  DEFECTIVE_EXCHANGE: 'Defective exchange',
  TRANSFER_FIX: 'Stocks Out settled',
};

const NEEDS_REASON: ManualMovementType[] = ['ADJUSTMENT', 'DAMAGED', 'RETURN_TO_SUPPLIER'];

export const movementFormSchema = z
  .object({
    type: z.enum(MANUAL_MOVEMENT_TYPES),
    productId: z.string().min(1, 'Choose a product'),
    condition: z.enum(['full', 'empty', 'unit', 'defective']),
    direction: z.enum(['add', 'remove']),
    qty: wholeNumber('Quantity', 1, 10_000),
    reason: z.string().trim().max(200, 'Keep the reason under 200 characters'),
    day: z
      .string()
      .refine(isValidDay, 'Enter a date as YYYY-MM-DD')
      .refine((day) => day <= localDay(new Date()), "The date can't be in the future"),
    counterpartLocationId: z.string(),
  })
  .superRefine((value, ctx) => {
    if (NEEDS_REASON.includes(value.type) && value.reason.length < 3) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why (at least 3 characters)' });
    }
    if (value.type === 'DELIVERY_IN' && value.condition === 'defective') {
      ctx.addIssue({ code: 'custom', path: ['condition'], message: 'Stock from the depot comes in good condition' });
    }
    if (value.type === 'TRANSFER_OUT' && !value.counterpartLocationId) {
      ctx.addIssue({ code: 'custom', path: ['counterpartLocationId'], message: 'Choose the other branch or warehouse' });
    }
  });

export type MovementInput = z.output<typeof movementFormSchema>;

/** Ways to pay at the counter. 'credit' (on account) and 'cheque' are only offered in the Borrowing window. */
export type CounterPaymentMethod = Exclude<PaymentMethod, 'credit' | 'cheque'>;

export const PAYMENT_METHODS: CounterPaymentMethod[] = ['cash', 'gcash', 'maya', 'bank'];

/** Payment rules depend on the sale total, so the schema is built per sale. */
export function paymentFormSchema(total: Centavos) {
  return z
    .object({
      method: z.enum(['cash', 'gcash', 'maya', 'bank', 'cheque']),
      tendered: z.string(),
      reference: z.string().trim(),
      chequeNo: z.string().trim().max(30, 'Keep the cheque number under 30 characters').default(''),
      bank: z.string().trim().max(40, 'Keep the bank under 40 characters').default(''),
      cashOn: z.string().default(''),
    })
    .superRefine((value, ctx) => {
      if (value.method === 'cash') {
        const cash = parsePeso(value.tendered);
        if (cash === null) {
          ctx.addIssue({ code: 'custom', path: ['tendered'], message: 'Enter the cash received' });
        } else if (cash < total) {
          ctx.addIssue({ code: 'custom', path: ['tendered'], message: `Short by ${formatPeso(total - cash)}` });
        }
      } else if (value.method === 'cheque') {
        if (value.chequeNo.length < 3) ctx.addIssue({ code: 'custom', path: ['chequeNo'], message: 'Enter the cheque number' });
        if (value.bank.length < 2) ctx.addIssue({ code: 'custom', path: ['bank'], message: 'Enter the bank' });
        if (!isValidDay(value.cashOn)) ctx.addIssue({ code: 'custom', path: ['cashOn'], message: 'Enter the date it can be cashed' });
      } else if (value.reference.length < 4) {
        ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the reference number' });
      }
    })
    .transform((value): Payment => {
      const tendered = value.method === 'cash' ? (parsePeso(value.tendered) ?? total) : total;
      return {
        method: value.method,
        amount: total,
        tendered,
        change: tendered - total,
        reference: value.method === 'cash' || value.method === 'cheque' ? undefined : value.reference,
        ...(value.method === 'cheque' ? { cheque: { number: value.chequeNo, bank: value.bank, cashOn: value.cashOn } } : {}),
      };
    });
}

/**
 * The part of a sale on credit the customer pays now. Blank means nothing is
 * paid now. A post-dated cheque is taken afterwards with Record payment.
 */
export function downPaymentSchema(total: Centavos) {
  return z
    .object({ amount: z.string().trim(), method: z.enum(['cash', 'gcash', 'maya', 'bank']), reference: z.string().trim() })
    .superRefine((value, ctx) => {
      if (!value.amount) return;
      const amount = parsePeso(value.amount);
      if (amount === null || amount <= 0) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the amount paid now, or leave it blank' });
      } else if (amount >= total) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: `Enter less than ${formatPeso(total)}. A sale paid in full is made in the Sell window` });
      }
      if (value.method !== 'cash' && value.reference.length < 4) {
        ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the reference number' });
      }
    })
    .transform((value): Payment | null => {
      const amount = value.amount ? (parsePeso(value.amount) ?? 0) : 0;
      if (amount <= 0) return null;
      return { method: value.method, amount, tendered: amount, change: 0, ...(value.method === 'cash' ? {} : { reference: value.reference }) };
    });
}

/** A discount the cashier gives on one line: a percentage off, or the price for each unit. */
export function discountFormSchema(regular: Centavos) {
  return z
    .object({ kind: z.enum(['percent', 'price']), value: z.string().trim() })
    .superRefine((value, ctx) => {
      if (value.kind === 'percent') {
        const percent = Number(value.value);
        if (!/^\d+(\.\d{1,2})?$/.test(value.value) || percent <= 0 || percent > 100) {
          ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter a percentage from 1 to 100, like 10' });
        }
      } else {
        const price = parsePeso(value.value);
        if (price === null) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter the price for each, like 900' });
        else if (price >= regular) ctx.addIssue({ code: 'custom', path: ['value'], message: `Enter less than the regular ${formatPeso(regular)}` });
      }
    })
    .transform((value): Discount => (value.kind === 'percent' ? { kind: 'percent', percent: Number(value.value) } : { kind: 'price', price: parsePeso(value.value)! }));
}

export const voidFormSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(200),
});

/** A positive peso amount, as typed: "950", "1,250.50", "₱950". */
const isAmount = (value: string) => (parsePeso(value) ?? 0) > 0;

export interface ProductInput {
  kind: ProductKind;
  name: string;
  /** Empty: SGM makes a code from the name. */
  sku: string;
  brand?: string;
  sizeKg?: number;
  refillPrice?: Centavos;
  /** Cylinders: the refill plus the cylinder itself. Accessories: the unit price. */
  price: Centavos;
  lowStockAt: number;
  active: boolean;
}

/**
 * The product form. For a cylinder the owner types the refill price and the
 * price of the empty cylinder by itself; a new cylinder (cylinder + refill)
 * costs the two together. For an accessory, `price` is its price.
 */
export const productFormSchema = z
  .object({
    kind: z.enum(['cylinder', 'accessory']),
    name: z.string().trim().min(2, 'Enter a name').max(60, 'Keep the name under 60 characters'),
    sku: z
      .string()
      .trim()
      .max(20, 'Keep the code under 20 characters')
      .regex(/^[A-Za-z0-9.-]*$/, 'Use letters, numbers, dots and dashes only'),
    brand: z.string().trim().max(40, 'Keep the brand under 40 characters'),
    sizeKg: z.string().trim(),
    refillPrice: z.string().trim(),
    cylinderPrice: z.string().trim(),
    price: z.string().trim(),
    lowStockAt: wholeNumber('Low-stock level', 0, 10_000),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (value.kind !== 'cylinder') {
      if (!isAmount(value.price)) issue('price', 'Enter a price, like 950 or 950.50');
      return;
    }
    const size = Number(value.sizeKg);
    if (!/^\d+(\.\d+)?$/.test(value.sizeKg) || size <= 0 || size > 100) issue('sizeKg', 'Enter the size in kg, like 11 or 2.7');
    if (!isAmount(value.refillPrice)) issue('refillPrice', 'Enter the refill price, like 950');
    if (!isAmount(value.cylinderPrice)) issue('cylinderPrice', 'Enter the price of the empty cylinder by itself, like 1800');
  })
  .transform((value): ProductInput => {
    const cylinder = value.kind === 'cylinder';
    return {
      kind: value.kind,
      name: value.name.replace(/\s+/g, ' '),
      sku: value.sku.toUpperCase(),
      brand: cylinder && value.brand ? value.brand : undefined,
      sizeKg: cylinder ? Number(value.sizeKg) : undefined,
      refillPrice: cylinder ? parsePeso(value.refillPrice)! : undefined,
      price: cylinder ? parsePeso(value.refillPrice)! + parsePeso(value.cylinderPrice)! : parsePeso(value.price)!,
      lowStockAt: value.lowStockAt,
      active: value.active,
    };
  });

export interface SetInput {
  name: string;
  items: SetItem[];
  /** Other sets inside this one. */
  sets: NestedSet[];
  price: Centavos;
  active: boolean;
}

export const setFormSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the set a name').max(60, 'Keep the name under 60 characters'),
    items: z.array(
      z.object({
        productId: z.string().min(1, 'Choose a product for every item'),
        type: z.enum(['refill', 'new', 'item']),
        qty: wholeNumber('Each quantity', 1, 100),
      }),
    ),
    sets: z.array(
      z.object({
        setId: z.string().min(1, 'Choose a set for every set row'),
        qty: wholeNumber('Each quantity', 1, 100),
      }),
    ),
    price: z.string().trim().refine(isAmount, 'Enter the set price, like 3250'),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.items.length === 0 && value.sets.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Add at least one item or set' });
    }
    const keys = value.items.map((item) => `${item.productId}:${item.type}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'An item is listed twice; change its quantity instead' });
    }
    const setIds = value.sets.map((s) => s.setId);
    if (new Set(setIds).size !== setIds.length) {
      ctx.addIssue({ code: 'custom', path: ['sets'], message: 'A set is listed twice; change its quantity instead' });
    }
  })
  .transform(
    (value): SetInput => ({
      name: value.name.replace(/\s+/g, ' '),
      items: value.items,
      sets: value.sets,
      price: parsePeso(value.price)!,
      active: value.active,
    }),
  );

/** In the lend form, the borrower list's "new borrower" choice. */
export const NEW_BORROWER = 'new';

/** The Borrowing window's lend form: who, which cylinder, how many, and whether the refill is paid now. */
export const lendFormSchema = z
  .object({
    borrowerId: z.string().min(1, 'Choose who is borrowing'),
    newName: z.string().trim().max(60, 'Keep the name under 60 characters'),
    newPhone: z
      .string()
      .trim()
      .regex(/^[\d+() -]{0,20}$/, 'Enter a phone number, like 0917 123 4567'),
    productId: z.string().min(1, 'Choose a cylinder'),
    qty: wholeNumber('Quantity', 1, 100),
    paidNow: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.borrowerId === NEW_BORROWER && value.newName.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['newName'], message: "Enter the borrower's name" });
    }
  });

export const cylinderReturnFormSchema = z.object({
  borrowerId: z.string().min(1, 'Choose who is returning'),
  productId: z.string().min(1, 'Choose the cylinder'),
  qty: wholeNumber('Quantity', 1, 100),
});

/** Paying off a loan: the amount can be part of what they owe, but not more. */
export function loanPaymentFormSchema(owedByBorrower: (borrowerId: string) => Centavos) {
  return z
    .object({
      borrowerId: z.string().min(1, 'Choose who is paying'),
      amount: z.string().trim().refine(isAmount, 'Enter the amount, like 500'),
    })
    .superRefine((value, ctx) => {
      const owed = owedByBorrower(value.borrowerId);
      const amount = parsePeso(value.amount);
      if (value.borrowerId && amount !== null && amount > owed) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: `They owe ${formatPeso(Math.max(0, owed))}. Enter that or less.` });
      }
    })
    .transform((value) => ({ borrowerId: value.borrowerId, amount: parsePeso(value.amount)! }));
}

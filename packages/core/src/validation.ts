/**
 * Form rules shared by both apps. Forms hold what the person typed (strings);
 * each schema checks it and turns it into clean values.
 */
import { z } from 'zod';

import { localDay, isValidDay } from './dates';
import type { MovementType, Payment, PaymentMethod, ProductKind, SetItem } from './models';
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

/** Stock changes a person records by hand (sales record their own movements). */
export const MANUAL_MOVEMENT_TYPES = [
  'DELIVERY_IN',
  'TRANSFER_IN',
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
};

const NEEDS_REASON: ManualMovementType[] = ['ADJUSTMENT', 'DAMAGED', 'RETURN_TO_SUPPLIER'];

export const movementFormSchema = z
  .object({
    type: z.enum(MANUAL_MOVEMENT_TYPES),
    productId: z.string().min(1, 'Choose a product'),
    condition: z.enum(['full', 'empty', 'unit']),
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
    if ((value.type === 'TRANSFER_IN' || value.type === 'TRANSFER_OUT') && !value.counterpartLocationId) {
      ctx.addIssue({ code: 'custom', path: ['counterpartLocationId'], message: 'Choose the other branch or warehouse' });
    }
  });

export type MovementInput = z.output<typeof movementFormSchema>;

/** Ways to pay at the counter. 'credit' (on account) is only offered in the Borrowing window. */
export type CounterPaymentMethod = Exclude<PaymentMethod, 'credit'>;

export const PAYMENT_METHODS: CounterPaymentMethod[] = ['cash', 'gcash', 'maya', 'bank'];

/** Payment rules depend on the sale total, so the schema is built per sale. */
export function paymentFormSchema(total: Centavos) {
  return z
    .object({
      method: z.enum(['cash', 'gcash', 'maya', 'bank']),
      tendered: z.string(),
      reference: z.string().trim(),
    })
    .superRefine((value, ctx) => {
      if (value.method === 'cash') {
        const cash = parsePeso(value.tendered);
        if (cash === null) {
          ctx.addIssue({ code: 'custom', path: ['tendered'], message: 'Enter the cash received' });
        } else if (cash < total) {
          ctx.addIssue({ code: 'custom', path: ['tendered'], message: `Short by ${formatPeso(total - cash)}` });
        }
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
        reference: value.method === 'cash' ? undefined : value.reference,
      };
    });
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
  price: Centavos;
  lowStockAt: number;
  active: boolean;
}

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
    price: z.string().trim(),
    lowStockAt: wholeNumber('Low-stock level', 0, 10_000),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!isAmount(value.price)) issue('price', 'Enter a price, like 950 or 950.50');
    if (value.kind !== 'cylinder') return;
    const size = Number(value.sizeKg);
    if (!/^\d+(\.\d+)?$/.test(value.sizeKg) || size <= 0 || size > 100) issue('sizeKg', 'Enter the size in kg, like 11 or 2.7');
    if (!isAmount(value.refillPrice)) issue('refillPrice', 'Enter the refill price, like 950');
    else if (isAmount(value.price) && parsePeso(value.price)! <= parsePeso(value.refillPrice)!) {
      issue('price', 'A new cylinder costs more than a refill; the difference is the price of the cylinder');
    }
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
      price: parsePeso(value.price)!,
      lowStockAt: value.lowStockAt,
      active: value.active,
    };
  });

export interface SetInput {
  name: string;
  items: SetItem[];
  price: Centavos;
  active: boolean;
}

export const setFormSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the set a name').max(60, 'Keep the name under 60 characters'),
    items: z
      .array(
        z.object({
          productId: z.string().min(1, 'Choose a product for every item'),
          type: z.enum(['refill', 'new', 'item']),
          qty: wholeNumber('Each quantity', 1, 100),
        }),
      )
      .min(1, 'Add at least one item'),
    price: z.string().trim().refine(isAmount, 'Enter the set price, like 3250'),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const keys = value.items.map((item) => `${item.productId}:${item.type}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'An item is listed twice; change its quantity instead' });
    }
  })
  .transform(
    (value): SetInput => ({
      name: value.name.replace(/\s+/g, ' '),
      items: value.items,
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

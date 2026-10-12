/**
 * Form rules shared by both apps. Forms hold what the person typed (strings);
 * each schema checks it and turns it into clean values.
 */
import { z } from 'zod';

import { localDay, isValidDay } from './dates';
import type { MovementType, Payment, PaymentMethod } from './models';
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
  DELIVERY_IN: 'Delivery from supplier',
  SALE: 'Sale',
  EMPTY_IN: 'Empty received (refill)',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  ADJUSTMENT: 'Count adjustment',
  DAMAGED: 'Damaged / condemned',
  RETURN_TO_SUPPLIER: 'Return to supplier',
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

export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'gcash', 'maya', 'bank'];

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

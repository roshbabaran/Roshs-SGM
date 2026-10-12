/**
 * Money is stored as whole centavos (₱1.00 = 100) so totals never pick up
 * floating-point rounding errors.
 */
export type Centavos = number;

/** Converts pesos to centavos, e.g. peso(950) === 95000. */
export function peso(amount: number): Centavos {
  return Math.round(amount * 100);
}

/** Formats centavos for display, e.g. formatPeso(123450) === '₱1,234.50'. */
export function formatPeso(value: Centavos): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100).toString().padStart(2, '0');
  return `${sign}₱${whole}.${cents}`;
}

/** Parses what a cashier types ("1,000", "₱950.5") into centavos, or null if it isn't an amount. */
export function parsePeso(input: string): Centavos | null {
  const cleaned = input.replace(/[₱,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return parseInt(whole, 10) * 100 + parseInt(fraction.padEnd(2, '0'), 10);
}

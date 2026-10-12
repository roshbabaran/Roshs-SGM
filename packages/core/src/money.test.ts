import { describe, expect, it } from 'vitest';

import { formatPeso, parsePeso, peso } from './money';

describe('money', () => {
  it('formats centavos as pesos', () => {
    expect(formatPeso(123450)).toBe('₱1,234.50');
    expect(formatPeso(5)).toBe('₱0.05');
    expect(formatPeso(-95000)).toBe('-₱950.00');
    expect(formatPeso(peso(1_000_000))).toBe('₱1,000,000.00');
  });

  it('parses what a cashier types', () => {
    expect(parsePeso('1,000')).toBe(100000);
    expect(parsePeso('₱950.5')).toBe(95050);
    expect(parsePeso(' 20.05 ')).toBe(2005);
    expect(parsePeso('12.345')).toBeNull();
    expect(parsePeso('abc')).toBeNull();
    expect(parsePeso('')).toBeNull();
  });
});

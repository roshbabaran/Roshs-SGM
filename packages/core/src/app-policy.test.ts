import { describe, expect, it } from 'vitest';

import { compareVersions } from './app-policy';

describe('compareVersions', () => {
  it('compares each part as a number', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });

  it('treats anything unreadable as zero', () => {
    expect(compareVersions('', '0.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
  });
});

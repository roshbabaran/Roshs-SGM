import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A permanent ID for this PC, made on first launch. The owner approves it once
 * on the server (device registration) and the server refuses unknown devices.
 */
export function loadDeviceId(file: string): string {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { deviceId?: unknown };
    if (typeof saved.deviceId === 'string' && saved.deviceId) return saved.deviceId;
  } catch {
    // First launch: no file yet.
  }
  const deviceId = randomUUID();
  writeFileSync(file, JSON.stringify({ deviceId, createdAt: new Date().toISOString() }, null, 2));
  return deviceId;
}

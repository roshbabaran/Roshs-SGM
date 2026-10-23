import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const VALID = /^[A-Za-z0-9-]{8,64}$/;

function read(file: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { deviceId?: unknown };
    return typeof saved.deviceId === 'string' && VALID.test(saved.deviceId) ? saved.deviceId : null;
  } catch {
    return null;
  }
}

/** Written to a temporary file first, so a power cut mid-write can't leave a half-written file behind. */
function write(file: string, deviceId: string, createdAt: string): void {
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify({ deviceId, createdAt }, null, 2));
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.error(error);
  }
}

/**
 * A permanent ID for this PC, made on first launch. The owner approves it once
 * on the server (device registration) and the server refuses unknown devices.
 *
 * It lives in SGM Desk's data folder, which updates leave alone, with a copy
 * next to it: if one file is damaged (a power cut, say) the other brings it
 * back, rather than the PC getting a new ID that has to be approved again.
 */
export function loadDeviceId(file: string): string {
  const backup = file.replace(/\.json$/, '.backup.json');
  const main = read(file);
  const copy = read(backup);
  const deviceId = main ?? copy ?? randomUUID();
  const createdAt = new Date().toISOString();

  if (!main && !copy && (existsSync(file) || existsSync(backup))) {
    // Both are there but neither can be read: keep them for the owner to look at instead of writing over them.
    for (const damaged of [file, backup]) {
      if (existsSync(damaged)) {
        try {
          renameSync(damaged, `${damaged}.damaged-${Date.now()}`);
        } catch {
          // Written over below.
        }
      }
    }
  }
  if (main !== deviceId) write(file, deviceId, createdAt);
  if (copy !== deviceId) write(backup, deviceId, createdAt);
  return deviceId;
}

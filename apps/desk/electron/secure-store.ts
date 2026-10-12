/**
 * Keeps the sign-in token encrypted with Electron safeStorage, which uses
 * Windows' own encryption (DPAPI) tied to the Windows user account.
 */
import { safeStorage } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export function createSecureStore(file: string) {
  const persisted = safeStorage.isEncryptionAvailable();
  let items: Record<string, string> = {};
  if (persisted) {
    try {
      items = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      items = {};
    }
  }

  const save = () => {
    if (!persisted) return;
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(items));
    renameSync(temp, file);
  };

  return {
    getItem(key: string): string | null {
      const stored = items[key];
      if (!stored) return null;
      if (!persisted) return stored;
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      // Without OS encryption the token stays in memory only, so people sign in again after a restart.
      items[key] = persisted ? safeStorage.encryptString(value).toString('base64') : value;
      save();
    },
    removeItem(key: string): void {
      delete items[key];
      save();
    },
  };
}

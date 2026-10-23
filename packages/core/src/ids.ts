type UuidGenerator = () => string;

type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
};

let customGenerator: UuidGenerator | null = null;

/**
 * Lets an app plug in its platform's UUID source at startup.
 * SGM Pocket passes expo-crypto's randomUUID, because phones have no global `crypto`.
 */
export function setUuidGenerator(generator: UuidGenerator): void {
  customGenerator = generator;
}

/**
 * Every record gets an ID made on the device, so a sale retried after a dropped
 * connection keeps the same ID and the server can ignore the duplicate.
 */
export function uuid(): string {
  if (customGenerator) return customGenerator();

  const random = (globalThis as { crypto?: RandomSource }).crypto;
  if (random?.randomUUID) return random.randomUUID();

  if (random?.getRandomValues) {
    const bytes = random.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  throw new Error('No secure random source. Call setUuidGenerator() when the app starts.');
}

/** First block of a UUID, used where a short, readable device code is enough. */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 6).toUpperCase();
}

/** Letters and digits that can't be mistaken for each other when read aloud or copied by hand. */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A 6-character code for a prepaid receipt, e.g. "K7Q2MX". The customer shows it to pick up the order. */
export function claimCode(): string {
  const hex = uuid().replace(/-/g, '');
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_LETTERS[parseInt(hex.slice(i * 4, i * 4 + 4), 16) % CODE_LETTERS.length];
  return code;
}

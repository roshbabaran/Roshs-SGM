/**
 * Business settings in one place. Replace the placeholders before printing
 * receipts for real customers.
 */
export const BUSINESS = {
  name: 'Sibugay Gas Marketing',
  /** Placeholder: put the store's real address here. */
  address: 'Business address',
  /** Placeholder: put the real TIN here once registered. */
  tin: 'TIN 000-000-000-000',
};

/**
 * Printed at the bottom of every receipt. Keep the "not an official receipt"
 * line until the system is registered with the BIR for issuing receipts.
 */
export const RECEIPT_FOOTER = ['Thank you for your purchase!', 'THIS IS NOT AN OFFICIAL RECEIPT'];

/** When false, the counter cannot sell more full cylinders than the branch has on record. */
export const ALLOW_NEGATIVE_STOCK = false;

/** How long a signed-in device may keep working without reaching the server. */
export const OFFLINE_GRACE_HOURS = 72;

/** How often each device tries to send and receive changes. */
export const SYNC_INTERVAL_MS = 30_000;

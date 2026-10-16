/**
 * Stage 11, first half: learning from corrections. When the cashier picks a
 * different product for a line, or confirms an unsure match, the written item
 * text is remembered with what it turned out to be, so the next receipt with
 * the same spelling ("Ptrn 11k ref") matches straight away. Kept in this
 * device's local settings; it isn't sent to the server.
 */
import type { MetaRecord } from '../models';
import { put, type ObservableStore } from '../store';
import { normalizeItemText } from './normalize';
import type { DraftLine, DraftTarget } from './types';

const ALIASES_ID = 'ocr-aliases';
/** Oldest spellings are forgotten past this many. */
const MAX_ALIASES = 500;

export type OcrAliases = Record<string, DraftTarget>;

export async function loadOcrAliases(store: ObservableStore): Promise<OcrAliases> {
  const record = await store.get<MetaRecord<OcrAliases>>('meta', ALIASES_ID);
  return record?.value ?? {};
}

function same(a: DraftTarget | null, b: DraftTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Spellings to remember from a reviewed receipt: lines whose product the
 * cashier changed or picked, and unsure matches they kept. `read` holds the
 * lines as the reader made them, `reviewed` the same lines after review (lines
 * the cashier added by hand have no read text and are skipped).
 */
export function learnedAliases(read: DraftLine[], reviewed: Pick<DraftLine, 'item' | 'target'>[]): OcrAliases {
  const learned: OcrAliases = {};
  reviewed.forEach((line) => {
    const original = read.find((r) => r.item.read !== '' && r.item.read === line.item.read);
    if (!original || !line.target) return;
    const key = normalizeItemText(original.item.read);
    if (key.length < 3) return;
    if (!same(original.target, line.target) || original.targetStatus !== 'ok') learned[key] = line.target;
  });
  return learned;
}

export async function saveOcrAliases(store: ObservableStore, learned: OcrAliases): Promise<void> {
  if (Object.keys(learned).length === 0) return;
  const current = await loadOcrAliases(store);
  for (const key of Object.keys(learned)) delete current[key];
  const merged = Object.entries({ ...current, ...learned });
  const value = Object.fromEntries(merged.slice(Math.max(0, merged.length - MAX_ALIASES)));
  await store.batch([put('meta', { id: ALIASES_ID, value })]);
}

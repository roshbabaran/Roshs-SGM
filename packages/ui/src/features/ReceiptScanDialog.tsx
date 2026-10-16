import {
  draftFromLines,
  draftProblem,
  draftToCart,
  formatDay,
  formatPeso,
  learnedAliases,
  listPriceOf,
  loadOcrAliases,
  photoProblem,
  photoQuality,
  priceCart,
  saveOcrAliases,
  type CartLine,
  type Catalogue,
  type DraftField,
  type DraftLine,
  type DraftTarget,
  type Product,
  type ProductSet,
  type ReceiptDraft,
  type Rect,
} from '@sgm/core';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';

import { Badge, Banner, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Icon, type IconName } from '../Icon';
import { Select } from '../Select';
import { useServices, type PhotoSource, type ScanPhoto } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, toneColors, useTheme } from '../theme';

/** What the cashier confirmed from a scanned receipt. */
export interface ScannedSale {
  cart: CartLine[];
  /** The number printed on the receipt, when there is one. */
  slipNo?: string;
}

/** A line under review: as the reader made it (null for a line added by hand), and the cashier's choices. */
interface ReviewLine {
  key: number;
  read: DraftLine | null;
  target: DraftTarget | null;
  qty: string;
}

type Step =
  | { kind: 'start'; photo?: ScanPhoto; problem?: string }
  | { kind: 'reading'; photo: ScanPhoto }
  | { kind: 'review'; photo: ScanPhoto; draft: ReceiptDraft };

const SOURCES: Record<PhotoSource, { title: string; again: string; icon: IconName }> = {
  camera: { title: 'Take photo', again: 'Take another photo', icon: 'camera-outline' },
  library: { title: 'Choose from gallery', again: 'Choose another photo', icon: 'images-outline' },
  file: { title: 'Choose photo', again: 'Choose another photo', icon: 'folder-open-outline' },
};

/** Tallest a line's crop of the photo is drawn. */
const CROP_HEIGHT = 56;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Lets the progress step show before the reader keeps the device busy. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function optionValue(target: DraftTarget): string {
  return target.kind === 'set' ? `s:${target.setId}` : `p:${target.productId}`;
}

function sameTarget(a: DraftTarget | null, b: DraftTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function qtyField(text: string): DraftField<number> {
  return { value: /^\d{1,3}$/.test(text) && Number(text) > 0 ? Number(text) : null, read: text, status: 'ok' };
}

/**
 * Scanning a handwritten receipt into the sale: take or choose a photo, let
 * the reader fill in the lines, then check each line against the photo.
 * Nothing is saved here. The confirmed lines go into the cart and the sale is
 * charged as usual.
 */
export function ReceiptScanDialog({
  visible,
  products,
  sets,
  replacing,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  /** Products and sets that can be sold now. */
  products: Product[];
  sets: ProductSet[];
  /** The cart already has items, and the receipt's lines will replace them. */
  replacing: boolean;
  onCancel: () => void;
  /** Puts the lines in the cart. If it throws (not enough stock, say), the message is shown here and nothing is lost. */
  onConfirm: (sale: ScannedSale) => void | Promise<void>;
}) {
  const { ocr, store } = useServices();
  const { colors } = useTheme();
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [receiptNo, setReceiptNo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Each pick or read gets a number, so a result that arrives after the dialog closed or restarted is dropped. */
  const run = useRef(0);
  const nextKey = useRef(0);

  useEffect(() => {
    if (!visible) return;
    setStep({ kind: 'start' });
    setLines([]);
    setReceiptNo('');
    setError(null);
    return () => {
      run.current += 1;
    };
  }, [visible]);

  const catalogue: Catalogue = { products, sets };
  const productsById = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));

  const read = async (photo: ScanPhoto) => {
    if (!ocr) return;
    const id = (run.current += 1);
    setError(null);
    setStep({ kind: 'reading', photo });
    try {
      await afterPaint();
      const [text, aliases] = await Promise.all([ocr.readText(photo.image), loadOcrAliases(store)]);
      if (id !== run.current) return;
      const draft = draftFromLines(text.lines, photo.image, { ...catalogue, aliases });
      draft.timings = text.timings;
      setLines(
        draft.lines.map((line) => ({ key: (nextKey.current += 1), read: line, target: line.target, qty: line.qty.value ? String(line.qty.value) : '' })),
      );
      setReceiptNo(draft.receiptNo.value ?? '');
      setStep({ kind: 'review', photo, draft });
    } catch (e) {
      if (id !== run.current) return;
      setStep({ kind: 'start', photo });
      setError(messageOf(e));
    }
  };

  const scan = async (source: PhotoSource) => {
    if (!ocr) return;
    const id = (run.current += 1);
    setError(null);
    let photo: ScanPhoto | null;
    try {
      photo = await ocr.pickPhoto(source);
    } catch (e) {
      if (id === run.current) setError(messageOf(e));
      return;
    }
    if (!photo || id !== run.current) return;
    const problem = photoProblem(photoQuality(photo.image));
    if (problem) setStep({ kind: 'start', photo, problem });
    else void read(photo);
  };

  const reviewed = lines.map((line) => ({ target: line.target, qty: qtyField(line.qty) }));
  const problem = draftProblem(reviewed);
  const cart = draftToCart(reviewed);
  const { total } = priceCart(cart, productsById, setsById);

  const change = (key: number, next: Partial<ReviewLine>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...next } : line)));
  const remove = (key: number) => setLines((current) => current.filter((line) => line.key !== key));
  const addLine = () => setLines((current) => [...current, { key: (nextKey.current += 1), read: null, target: null, qty: '1' }]);

  const confirm = async () => {
    if (step.kind !== 'review' || problem) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ cart, slipNo: receiptNo.trim() || undefined });
      // Spellings the cashier corrected are remembered on this device, so the next receipt matches straight away.
      const corrected = learnedAliases(
        step.draft.lines,
        lines.flatMap((line) => (line.read ? [{ item: line.read.item, target: line.target }] : [])),
      );
      void saveOcrAliases(store, corrected).catch(() => undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const options = [
    ...products.map((p) => ({
      label: p.name,
      value: `p:${p.id}`,
      hint: p.kind === 'cylinder' ? `Refill ${formatPeso(p.refillPrice ?? p.price)} · New ${formatPeso(p.price)}` : formatPeso(p.price),
    })),
    ...sets.map((s) => ({ label: s.name, value: `s:${s.id}`, hint: `Set · ${formatPeso(s.price)}` })),
  ];

  let content;
  let actions;
  if (!ocr) {
    content = <Banner tone="info">Scanning receipts isn't available on this device.</Banner>;
    actions = <Button title="Close" variant="secondary" onPress={onCancel} />;
  } else if (step.kind === 'start') {
    content = (
      <>
        <Text muted>
          Lay the receipt flat in good light, with the whole receipt in the photo and no shadow over the writing. Take it before the receipt goes to the
          customer.
        </Text>
        {step.photo ? <PhotoPreview photo={step.photo} height={220} /> : null}
        {step.problem ? <Banner tone="warning">{step.problem}</Banner> : null}
        <View style={styles.sources}>
          {ocr.sources.map((source, i) => (
            <Button
              key={source}
              title={step.photo ? SOURCES[source].again : SOURCES[source].title}
              icon={SOURCES[source].icon}
              variant={i === 0 ? undefined : 'secondary'}
              onPress={() => void scan(source)}
            />
          ))}
          {step.problem && step.photo ? <Button title="Read it anyway" variant="ghost" onPress={() => step.photo && void read(step.photo)} /> : null}
        </View>
      </>
    );
    actions = <Button title="Cancel" variant="secondary" onPress={onCancel} />;
  } else if (step.kind === 'reading') {
    content = (
      <>
        <PhotoPreview photo={step.photo} height={220} />
        <View style={styles.reading}>
          <ActivityIndicator color={colors.primary} />
          <Text muted style={styles.flex}>
            Reading the receipt… The first one after opening the app takes a little longer.
          </Text>
        </View>
      </>
    );
    actions = <Button title="Cancel" variant="secondary" onPress={onCancel} />;
  } else {
    const { draft, photo } = step;
    const written = draft.total.value;
    content = (
      <>
        <PhotoPreview photo={photo} height={260} expandable />
        <View style={styles.fields}>
          <TextField
            label="Receipt no."
            value={receiptNo}
            onChangeText={setReceiptNo}
            hint={draft.receiptNo.note ?? 'Saved with the sale, so the same receipt is not entered twice.'}
            autoCapitalize="characters"
            containerStyle={styles.field}
          />
          <ReadValue
            label="Date on receipt"
            value={draft.date.value ? formatDay(draft.date.value) : draft.date.read || 'Not found'}
            field={draft.date}
          />
          <ReadValue label="Written total" value={written !== null ? formatPeso(written) : 'Not found'} field={draft.total} />
        </View>

        <View style={styles.items}>
          <Text variant="label">Items</Text>
          {draft.lines.length === 0 ? <Banner tone="warning">{draft.notes.join(' ')}</Banner> : null}
          {lines.map((line) => (
            <ReviewRow
              key={line.key}
              line={line}
              photo={photo}
              products={productsById}
              catalogue={catalogue}
              options={options}
              onChange={(next) => change(line.key, next)}
              onRemove={() => remove(line.key)}
            />
          ))}
          <View style={styles.addRow}>
            <Button title="Add a line" icon="add" variant="secondary" size="sm" onPress={addLine} />
          </View>
        </View>

        <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
          <View style={styles.flex}>
            <Text weight="600">Sale total</Text>
            <Text variant="small" muted>
              At SGM's prices, which the sale uses
            </Text>
          </View>
          <Text variant="heading" numeric>
            {formatPeso(total)}
          </Text>
        </View>
        {!problem && written !== null && total !== written ? (
          <Banner tone="warning">{`The receipt says ${formatPeso(written)}. Check the quantities and products against the photo.`}</Banner>
        ) : null}
        {problem ? <Banner tone="info">{problem}</Banner> : null}
      </>
    );
    actions = (
      <>
        <Button title="Scan again" icon="refresh" variant="secondary" onPress={() => setStep({ kind: 'start' })} disabled={busy} />
        <Button title={replacing ? 'Replace current sale' : 'Add to sale'} icon="checkmark" onPress={() => void confirm()} disabled={!!problem} loading={busy} />
      </>
    );
  }

  return (
    <Dialog
      visible={visible}
      title={step.kind === 'review' ? 'Check the receipt' : 'Scan a receipt'}
      onClose={onCancel}
      width={step.kind === 'review' ? 760 : 480}
      dismissable={!busy}
      actions={actions}
    >
      {content}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

/** One receipt line: what was written, and the product, sale type and quantity the cashier confirms. */
function ReviewRow({
  line,
  photo,
  products,
  catalogue,
  options,
  onChange,
  onRemove,
}: {
  line: ReviewLine;
  photo: ScanPhoto;
  products: Map<string, Product>;
  catalogue: Catalogue;
  options: { label: string; value: string; hint?: string }[];
  onChange: (next: Partial<ReviewLine>) => void;
  onRemove: () => void;
}) {
  const { colors } = useTheme();
  const { read, target } = line;
  const product = target?.kind === 'product' ? products.get(target.productId) : undefined;
  const picked = !read || !sameTarget(read.target, target);
  const listPrice = target ? listPriceOf(target, catalogue) : null;
  const unsureNumbers = read ? [read.qty, read.unitPrice, read.amount].some((field) => field.status !== 'ok') : false;
  const notes = [picked ? undefined : read?.targetNote, read?.qty.note, read?.unitPrice.note, read?.amount.note].filter((note): note is string => !!note);

  // Likely products first, so a close call is one tap away.
  const likely = new Set((read?.candidates ?? []).map(optionValue));
  const ordered = [
    ...options.filter((o) => likely.has(o.value)).map((o) => ({ ...o, hint: `Likely · ${o.hint ?? ''}` })),
    ...options.filter((o) => !likely.has(o.value)),
  ];

  /** Refill or new for a cylinder, from the written price when it matches one of them. */
  const typeFor = (next: Product): 'refill' | 'new' | 'item' => {
    if (next.kind !== 'cylinder') return 'item';
    const qty = read?.qty.value ?? null;
    const amount = read?.amount.value ?? null;
    const each = read?.unitPrice.value ?? (amount !== null && qty ? amount / qty : null);
    if (each === next.price && each !== next.refillPrice) return 'new';
    if (each === (next.refillPrice ?? next.price)) return 'refill';
    return target?.kind === 'product' && target.type === 'new' ? 'new' : 'refill';
  };

  const pick = (value: string) => {
    if (value.startsWith('s:')) return onChange({ target: { kind: 'set', setId: value.slice(2) } });
    const next = products.get(value.slice(2));
    if (next) onChange({ target: { kind: 'product', productId: next.id, type: typeFor(next) } });
  };

  return (
    <View style={[styles.row, { borderColor: target ? colors.border : colors.danger, backgroundColor: colors.surface }]}>
      {read ? <PhotoCrop photo={photo} rect={read.rect} /> : null}
      <View style={styles.rowControls}>
        <View style={styles.rowProduct}>
          <Select value={target ? optionValue(target) : ''} options={ordered} placeholder="Pick the product…" onChange={pick} />
        </View>
        {product?.kind === 'cylinder' && target?.kind === 'product' ? (
          <SegmentedControl
            size="sm"
            accessibilityLabel={`${product.name} sale type`}
            options={[
              { label: 'Refill', value: 'refill' },
              { label: 'New', value: 'new' },
            ]}
            value={target.type === 'new' ? 'new' : 'refill'}
            onChange={(type) => onChange({ target: { ...target, type } })}
          />
        ) : null}
        <TextField
          value={line.qty}
          onChangeText={(text) => onChange({ qty: text.replace(/\D/g, '').slice(0, 3) })}
          keyboardType="number-pad"
          accessibilityLabel="Quantity"
          placeholder="Qty"
          containerStyle={styles.qty}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Remove this line" onPress={onRemove} style={styles.remove}>
          <Icon name="trash-outline" color={colors.danger} />
        </Pressable>
      </View>
      <View style={styles.rowInfo}>
        {!target ? <Badge label="Pick the product" tone="danger" /> : !picked && read?.targetStatus !== 'ok' ? <Badge label="Check the product" tone="warning" /> : null}
        {unsureNumbers ? <Badge label="Check the numbers" tone="warning" /> : null}
        <Text variant="small" muted numeric style={styles.flex}>
          {[
            read ? `Written: ${read.qty.read || '?'} × ${read.unitPrice.read || '?'} = ${read.amount.read || '?'}` : 'Added by hand',
            listPrice !== null ? `SGM price ${formatPeso(listPrice)}${target?.kind === 'set' ? ' per set' : ' each'}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {notes.map((note) => (
        <Text key={note} variant="small" color={toneColors(colors, 'warning').fg}>
          {note}
        </Text>
      ))}
    </View>
  );
}

/** A value the reader found that the cashier only needs to look at. */
function ReadValue({ label, value, field }: { label: string; value: string; field: DraftField<unknown> }) {
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      <View style={styles.readValue}>
        <Text weight="600" numeric>
          {value}
        </Text>
        {field.status !== 'ok' ? <Badge label={field.status === 'missing' ? 'Not found' : 'Check'} tone="warning" /> : null}
      </View>
      {field.note ? (
        <Text variant="small" muted>
          {field.note}
        </Text>
      ) : null}
    </View>
  );
}

/** The whole photo, letterboxed. With `expandable`, tapping it shows it bigger. */
function PhotoPreview({ photo, height, expandable = false }: { photo: ScanPhoto; height: number; expandable?: boolean }) {
  const { colors } = useTheme();
  const [big, setBig] = useState(false);
  const image = (
    <Image
      source={{ uri: photo.uri }}
      resizeMode="contain"
      accessibilityLabel="The receipt photo"
      style={[styles.photo, { height: big ? height * 2.5 : height, backgroundColor: colors.surfaceMuted }]}
    />
  );
  if (!expandable) return image;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={big ? 'Show the photo smaller' : 'Show the photo bigger'} onPress={() => setBig(!big)}>
      {image}
      <Text variant="small" muted align="center">
        {big ? 'Tap the photo to make it smaller' : 'Tap the photo to see it bigger'}
      </Text>
    </Pressable>
  );
}

/** The part of the photo where a line was written, so the cashier can compare it with what was read. */
function PhotoCrop({ photo, rect }: { photo: ScanPhoto; rect: Rect }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const pad = Math.round(rect.height * 0.25);
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const w = Math.min(photo.image.width, rect.x + rect.width + pad) - x;
  const h = Math.min(photo.image.height, rect.y + rect.height + pad) - y;
  const scale = width > 0 && w > 0 && h > 0 ? Math.min(width / w, CROP_HEIGHT / h) : 0;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityLabel="What was written on this line"
      style={[styles.crop, { height: scale ? Math.round(h * scale) : CROP_HEIGHT, backgroundColor: colors.surfaceMuted }]}
    >
      {scale ? (
        <Image
          source={{ uri: photo.uri }}
          style={{ position: 'absolute', left: -x * scale, top: -y * scale, width: photo.image.width * scale, height: photo.image.height * scale }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sources: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  reading: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  photo: { width: '100%', borderRadius: radius.md },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  field: { flexGrow: 1, flexBasis: 200, gap: spacing.xs },
  readValue: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 42 },
  items: { gap: spacing.sm },
  row: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: spacing.sm },
  rowControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  rowProduct: { flexGrow: 1, flexBasis: 220 },
  rowInfo: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  qty: { width: 72 },
  remove: { padding: spacing.xs, cursor: 'pointer' },
  crop: { width: '100%', overflow: 'hidden', borderRadius: radius.sm },
  addRow: { flexDirection: 'row' },
  totalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderTopWidth: 1, paddingTop: spacing.md },
});

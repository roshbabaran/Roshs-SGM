import {
  draftFromLines,
  draftToCart,
  formatPeso,
  formatTime,
  isValidDay,
  learnedAliases,
  listPriceOf,
  loadOcrAliases,
  localDay,
  parseReceiptTime,
  photoProblem,
  photoQuality,
  linkedCustomer,
  nameSuggestions,
  NAME_SUGGEST,
  readingImage,
  recordSale,
  saleTimeFor,
  saveOcrAliases,
  scannedSaleInput,
  scannedTotal,
  setContents,
  tidyName,
  CLOCK_SKEW_MS,
  type Catalogue,
  type Customer,
  type DraftLine,
  type DraftTarget,
  type Product,
  type ProductSet,
  type ReceiptDraft,
  type Rect,
  type Sale,
} from '@sgm/core';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';

import { Badge, Banner, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { DateField } from '../DateField';
import { Dialog } from '../Dialog';
import { Icon, type IconName } from '../Icon';
import { Select } from '../Select';
import { useCollection, useServices, useWork, type PhotoSource, type ScanPhoto } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { radius, spacing, toneColors, useTheme } from '../theme';

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

function qtyValue(text: string): number | null {
  return /^\d{1,3}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/** "14:30" as "2:30 PM". */
function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A line the sale can use: a product and a quantity of at least 1. */
const isComplete = (line: ReviewLine) => !!line.target && qtyValue(line.qty) !== null;

/**
 * Entering a sale from a handwritten receipt, from Transactions: take or
 * choose a photo, let the reader fill in the window, check and correct it
 * against the photo, then Save. Save records the sale straight away, paid in
 * cash at SGM's prices, on the day (and time, if written) on the receipt.
 * Nothing is saved before Save, and the only things it needs are the date and
 * at least one line with a product and a quantity.
 */
export function ReceiptScanDialog({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved?: (sale: Sale) => void }) {
  const { ocr, store } = useServices();
  const work = useWork();
  const { colors } = useTheme();
  const { data: products } = useCollection<Product>('products');
  const { data: sets } = useCollection<ProductSet>('sets');
  const { data: customers } = useCollection<Customer>('borrowers');
  const { data: sales } = useCollection<Sale>('sales');
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [receiptNo, setReceiptNo] = useState('');
  const [name, setName] = useState('');
  /** The customer the cashier picked for the written name. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Each pick or read gets a number, so a result that arrives after the window closed or restarted is dropped. */
  const run = useRef(0);
  const nextKey = useRef(0);

  useEffect(() => {
    if (!visible) return;
    setStep({ kind: 'start' });
    setLines([]);
    setReceiptNo('');
    setName('');
    setPickedId(null);
    setDay('');
    setTime('');
    setError(null);
    return () => {
      run.current += 1;
    };
  }, [visible]);

  const today = localDay(new Date());
  const byId = new Map(products.map((p) => [p.id, p]));
  const allSets = new Map(sets.map((set) => [set.id, set]));
  // A set can be sold only while every product in it, and in the sets inside it, still exists.
  const setsById = new Map(sets.filter((set) => setContents(set, allSets).every((item) => byId.has(item.productId))).map((set) => [set.id, set]));
  const activeProducts = products.filter((p) => p.active);
  const activeSets = Array.from(setsById.values()).filter((set) => set.active);
  const catalogue: Catalogue = { products: activeProducts, sets: activeSets };

  const read = async (photo: ScanPhoto) => {
    if (!ocr) return;
    const id = (run.current += 1);
    setError(null);
    setStep({ kind: 'reading', photo });
    try {
      await afterPaint();
      const [text, aliases] = await Promise.all([ocr.readText(readingImage(photo.image)), loadOcrAliases(store)]);
      if (id !== run.current) return;
      const draft = draftFromLines(text.lines, photo.image, { ...catalogue, aliases }, { today });
      draft.timings = text.timings;
      setLines(
        draft.lines.map((line) => ({ key: (nextKey.current += 1), read: line, target: line.target, qty: line.qty.value ? String(line.qty.value) : '' })),
      );
      setReceiptNo(draft.receiptNo.value ?? '');
      setName(draft.registeredName.value ?? '');
      setPickedId(null);
      setDay(draft.date.value ?? '');
      setTime(draft.time.value ? timeLabel(draft.time.value) : '');
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

  // The written name links a customer only when it is theirs exactly, or when the cashier picks them.
  const typed = tidyName(name);
  const picked = pickedId ? (customers.find((c) => c.id === pickedId) ?? null) : null;
  const linked = linkedCustomer(name, pickedId, customers);
  const q = typed.toLowerCase();
  // Customers whose names are close to what was read ("loy Navarro" finds Joy Navarro), then ones containing what was typed.
  const close = linked ? [] : nameSuggestions(typed, customers);
  const likely = close[0] && close[0].similarity >= NAME_SUGGEST.likely ? close[0].customer : null;
  const containing =
    q.length >= 2
      ? customers
          .filter((c) => c.name.toLowerCase().includes(q) || q.split(' ').some((word) => word.length >= 3 && c.name.toLowerCase().includes(word)))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  const suggestions = [...close.map((s) => s.customer), ...containing]
    .filter((c, i, all) => c.id !== linked?.id && all.findIndex((other) => other.id === c.id) === i)
    .slice(0, 4);
  /** Picking a customer links them and puts their name in the field, as the cashier confirmed it. */
  const pick = (customer: Customer) => {
    setPickedId(customer.id);
    setName(customer.name);
  };

  // When the sale happened.
  const timeText = time.trim();
  const writtenTime = timeText ? parseReceiptTime(timeText) : null;
  const dayOk = isValidDay(day) && day <= today;
  let when: { soldAt: string; timeEstimated: boolean } | null = null;
  try {
    when = dayOk && (!timeText || writtenTime) ? saleTimeFor(day, writtenTime, new Date()) : null;
  } catch {
    when = null;
  }
  const inFuture = !!when && new Date(when.soldAt).getTime() > Date.now() + CLOCK_SKEW_MS;
  const timeHint = !dayOk
    ? 'Used with the date.'
    : writtenTime
      ? `${timeLabel(writtenTime)}${step.kind === 'review' && step.draft.time.value === writtenTime ? ' (on the receipt)' : ''}`
      : day === today
        ? `${formatTime(new Date().toISOString())}, the time you press Save (not on the receipt)`
        : '11:59 PM (not on the receipt)';

  const slip = receiptNo.trim();
  const repeated = slip ? sales.find((s) => s.slipNo === slip && s.locationId === work.locationId && s.status === 'completed') : undefined;

  const complete = lines.filter(isComplete);
  const incomplete = lines.length - complete.length;
  const cart = draftToCart(complete.map((line) => ({ target: line.target, qty: { value: qtyValue(line.qty), read: line.qty, status: 'ok' as const } })));
  // The same pricing Save sends to recordSale, so a linked customer's own prices show here too.
  const total = scannedTotal({ cart, customer: linked, products: byId, sets: setsById });

  const missing = [
    !day ? 'the date of the sale' : !dayOk ? "a date that isn't after today" : null,
    timeText && !writtenTime ? 'the time like 2:30 PM, or no time' : inFuture ? "a time that isn't later than now" : null,
    complete.length === 0 ? 'at least one line with a product and a quantity' : null,
  ].filter((m): m is string => !!m);
  const canSave = step.kind === 'review' && missing.length === 0 && !!when && !busy;

  const change = (key: number, next: Partial<ReviewLine>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...next } : line)));
  const remove = (key: number) => setLines((current) => current.filter((line) => line.key !== key));
  const addLine = () => setLines((current) => [...current, { key: (nextKey.current += 1), read: null, target: null, qty: '1' }]);

  const save = async () => {
    if (step.kind !== 'review' || !canSave || !when) return;
    setBusy(true);
    setError(null);
    try {
      // Taken again now: a sale dated today without a time gets the moment Save is pressed.
      const at = saleTimeFor(day, writtenTime, new Date());
      const { input } = scannedSaleInput({
        cart,
        name,
        customer: linked,
        products: byId,
        sets: setsById,
        slipNo: slip,
        soldAt: at.soldAt,
        timeEstimated: at.timeEstimated,
      });
      const sale = await recordSale(work.ctx, input);
      // Spellings the cashier corrected are remembered on this device, so the next receipt matches straight away.
      const corrected = learnedAliases(
        step.draft.lines,
        lines.flatMap((line) => (line.read ? [{ item: line.read.item, target: line.target }] : [])),
      );
      void saveOcrAliases(store, corrected).catch(() => undefined);
      onSaved?.(sale);
    } catch (e) {
      // Not enough stock, a receipt number already entered: fixed here, then saved again.
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const options = [
    ...activeProducts.map((p) => ({
      label: p.name,
      value: `p:${p.id}`,
      hint: p.kind === 'cylinder' ? `Refill ${formatPeso(p.refillPrice ?? p.price)} · New ${formatPeso(p.price)}` : formatPeso(p.price),
    })),
    ...activeSets.map((s) => ({ label: s.name, value: `s:${s.id}`, hint: `Set · ${formatPeso(s.price)}` })),
  ];

  let content;
  let actions;
  if (!ocr) {
    content = <Banner tone="info">Scanning receipts isn't available on this device.</Banner>;
    actions = <Button title="Close" variant="secondary" onPress={onClose} />;
  } else if (step.kind === 'start') {
    content = (
      <>
        <Text muted>Lay the receipt flat in good light, with the whole receipt in the photo and no shadow over the writing.</Text>
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
    actions = <Button title="Cancel" variant="secondary" onPress={onClose} />;
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
    actions = <Button title="Cancel" variant="secondary" onPress={onClose} />;
  } else {
    const { draft, photo } = step;
    const written = draft.total.value;
    const amounts = lines.map((line) => line.read?.amount.value ?? null).filter((a): a is number => a !== null);
    const writtenSum = amounts.reduce((sum, a) => sum + a, 0);
    const writtenTotal = written ?? (amounts.length > 0 ? writtenSum : null);
    content = (
      <>
        <PhotoPreview photo={photo} height={260} expandable />
        <View style={styles.fields}>
          <View style={styles.field}>
            <TextField
              label="Registered Name (optional)"
              value={name}
              onChangeText={(text) => {
                setName(text);
                if (picked && tidyName(text).toLowerCase() !== picked.name.toLowerCase()) setPickedId(null);
              }}
              hint={
                linked
                  ? `Linked to the customer ${linked.name}.`
                  : likely
                    ? `Looks like the customer ${likely.name}. Tap their name below to link them, or keep it as written.`
                    : typed
                      ? 'Kept on the sale as written. No customer is linked.'
                      : (draft.registeredName.note ?? 'The name written on the receipt, if any.')
              }
              autoCapitalize="words"
            />
            {suggestions.length > 0 ? (
              <View style={styles.chips}>
                {suggestions.map((c) => (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Link to the customer ${c.name}`}
                    onPress={() => pick(c)}
                    style={[styles.chip, { borderColor: c.id === likely?.id ? colors.primary : colors.border, backgroundColor: colors.surfaceMuted }]}
                  >
                    <Icon name="person-outline" size={14} color={colors.textMuted} />
                    <Text variant="small">{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
          <View style={styles.field}>
            <DateField
              label="Date of transaction"
              value={day}
              onChange={setDay}
              max={today}
              error={day && !dayOk ? "The date can't be after today." : undefined}
            />
            {draft.date.note ? (
              <Text variant="small" muted>
                {draft.date.value ? draft.date.note : `${draft.date.note} Choose the date written on the receipt.`}
              </Text>
            ) : null}
          </View>
          <TextField
            label="Time (optional)"
            value={time}
            onChangeText={setTime}
            placeholder="e.g. 2:30 PM"
            error={timeText && !writtenTime ? 'Enter the time like 2:30 PM, or leave it empty.' : inFuture ? "That time hasn't come yet." : undefined}
            hint={`The sale will be at ${timeHint}.`}
            containerStyle={styles.field}
          />
          <TextField
            label="Receipt no. (optional)"
            value={receiptNo}
            onChangeText={setReceiptNo}
            error={repeated ? `Already entered as sale ${repeated.receiptNo}. Check the number on the receipt.` : undefined}
            hint={draft.receiptNo.note ?? 'Saved with the sale, so the same receipt is not entered twice.'}
            autoCapitalize="characters"
            containerStyle={styles.field}
          />
        </View>

        <View style={styles.items}>
          <Text variant="label">Items</Text>
          {draft.lines.length === 0 ? <Banner tone="warning">{draft.notes.join(' ')}</Banner> : null}
          {lines.map((line) => (
            <ReviewRow
              key={line.key}
              line={line}
              photo={photo}
              products={byId}
              catalogue={catalogue}
              options={options}
              onChange={(next) => change(line.key, next)}
              onRemove={() => remove(line.key)}
            />
          ))}
          <View style={styles.addRow}>
            <Button title="Add a line" icon="add" variant="secondary" size="sm" onPress={addLine} />
          </View>
          {incomplete > 0 && complete.length > 0 ? (
            <Banner tone="warning">
              {incomplete === 1
                ? 'One line has no product or quantity. It will be left out when you save.'
                : `${incomplete} lines have no product or quantity. They will be left out when you save.`}
            </Banner>
          ) : null}
        </View>

        <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
          <View style={styles.flex}>
            <Text weight="600">Sale total</Text>
            <Text variant="small" muted>
              {`At SGM's prices${linked?.discount ? `, with ${linked.name}'s prices` : ''}. Paid in cash.`}
            </Text>
            {writtenTotal !== null ? (
              <Text variant="small" muted numeric>
                {`Written on the receipt: ${formatPeso(writtenTotal)}${written === null ? ' (the amounts added up)' : ''}`}
              </Text>
            ) : null}
          </View>
          <Text variant="heading" numeric>
            {formatPeso(total)}
          </Text>
        </View>
        {complete.length > 0 && writtenTotal !== null && total !== writtenTotal ? (
          <Banner tone="warning">{`The receipt says ${formatPeso(writtenTotal)} but SGM's prices come to ${formatPeso(total)}. The sale is saved at SGM's prices; check the quantities and products against the photo.`}</Banner>
        ) : null}
        {missing.length > 0 ? <Banner tone="info">{`To save, enter ${joinWords(missing)}.`}</Banner> : null}
      </>
    );
    actions = (
      <>
        <Button title="Scan again" icon="refresh" variant="secondary" onPress={() => setStep({ kind: 'start' })} disabled={busy} />
        <Button title="Save" icon="checkmark" onPress={() => void save()} disabled={!canSave} loading={busy} />
      </>
    );
  }

  return (
    <Dialog
      visible={visible}
      title={step.kind === 'review' ? 'Check the receipt' : 'Scan a receipt'}
      onClose={onClose}
      width={step.kind === 'review' ? 760 : 480}
      dismissable={!busy}
      actions={actions}
    >
      {content}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

/** "a, b and c". */
function joinWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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
  const complete = isComplete(line);
  // A quantity the reader worked out or set to 1, which the cashier hasn't changed yet.
  const qtyGuessed = !!read && read.qty.status !== 'ok' && read.qty.value !== null && line.qty === String(read.qty.value);
  const unsureNumbers = read ? [read.unitPrice, read.amount].some((field) => field.status !== 'ok' && field.value !== null) : false;
  const notes = [picked ? undefined : read?.targetNote, qtyGuessed ? read?.qty.note : undefined, read?.unitPrice.note, read?.amount.note].filter(
    (note): note is string => !!note,
  );

  // Likely products first, so a close call is one tap away.
  const likely = new Set((read?.candidates ?? []).map(optionValue));
  const ordered = [
    ...(read?.candidates ?? []).flatMap((c) => options.filter((o) => o.value === optionValue(c)).map((o) => ({ ...o, hint: `Likely · ${o.hint ?? ''}` }))),
    ...options.filter((o) => !likely.has(o.value)),
  ].filter((o, i, all) => all.findIndex((other) => other.value === o.value) === i);

  /** Refill or new for a cylinder, from the written price when it matches one of them. */
  const typeFor = (next: Product): 'refill' | 'new' | 'item' => {
    if (next.kind !== 'cylinder') return 'item';
    const qty = read?.qty.value ?? null;
    const amount = read?.amount.value ?? null;
    const each = read?.unitPrice.value ?? (amount !== null && qty ? amount / qty : null);
    if (each === next.price && each !== next.refillPrice) return 'new';
    if (each === (next.refillPrice ?? next.price)) return 'refill';
    const candidate = read?.candidates.find((c) => c.kind === 'product' && c.productId === next.id);
    if (candidate?.kind === 'product' && candidate.type !== 'item') return candidate.type;
    return target?.kind === 'product' && target.type === 'new' ? 'new' : 'refill';
  };

  const pick = (value: string) => {
    if (value.startsWith('s:')) return onChange({ target: { kind: 'set', setId: value.slice(2) } });
    const next = products.get(value.slice(2));
    if (next) onChange({ target: { kind: 'product', productId: next.id, type: typeFor(next) } });
  };

  return (
    <View style={[styles.row, { borderColor: complete ? colors.border : colors.warning, backgroundColor: colors.surface }]}>
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
        {!complete ? <Badge label={target ? 'No quantity: left out on Save' : 'No product: left out on Save'} tone="warning" /> : null}
        {target && !picked && read?.targetStatus !== 'ok' ? <Badge label="Check the product" tone="warning" /> : null}
        {qtyGuessed ? <Badge label="Check the quantity" tone="warning" /> : null}
        {unsureNumbers ? <Badge label="Check the numbers" tone="warning" /> : null}
        <Text variant="small" muted numeric style={styles.flex}>
          {[
            read ? `Written: ${read.item.read || '?'} · ${read.qty.read || '?'} × ${read.unitPrice.read || '?'} = ${read.amount.read || '?'}` : 'Added by hand',
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 4 },
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

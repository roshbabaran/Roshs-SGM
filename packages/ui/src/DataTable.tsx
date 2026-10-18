import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { TextField } from './TextField';
import { radius, spacing, useTheme } from './theme';

export interface Column<T> {
  key: string;
  title: string;
  /** Fixed width in pixels; otherwise the column shares space using `flex`. */
  width?: number;
  flex?: number;
  align?: 'left' | 'right' | 'center';
  /**
   * Labels under the title, such as Full and Empty, each over its own part of
   * the column. The cells draw their parts with SplitCell.
   */
  subColumns?: string[];
  /** Plain text for the cell; also used for searching and sorting when those aren't given. */
  text?: (row: T) => string;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  pageSize?: number;
  /** Shows a search box that matches against every column's text. */
  searchPlaceholder?: string;
  onRowPress?: (row: T) => void;
  emptyText?: string;
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  /** Narrow screens scroll sideways below this width. */
  minWidth?: number;
  toolbar?: ReactNode;
}

type Sort = { key: string; direction: 'asc' | 'desc' } | null;

const FitHeightContext = createContext<number | null>(null);

/**
 * Makes the tables inside fit the screen, for phones: the first column stays in
 * place, the other columns and the rows are paged with buttons, and the table
 * is never taller than the page around it. Wrap a whole page in it.
 */
export function FitTablesToScreen({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState<number | null>(null);
  return (
    <View style={styles.fill} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      <FitHeightContext.Provider value={height}>{children}</FitHeightContext.Provider>
    </View>
  );
}

/** A sortable, searchable, paged table that works with a mouse and on a phone. */
export function DataTable<T>(props: DataTableProps<T>) {
  const fitHeight = useContext(FitHeightContext);
  return fitHeight === null ? <ScrollingTable {...props} /> : <FittedTable {...props} screenHeight={fitHeight} />;
}

/** Search, sort and paging, shared by both kinds of table. */
function useTableRows<T>({ rows, columns, initialSort }: DataTableProps<T>, pageSize: number) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(initialSort ?? null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => columns.some((c) => c.text?.(row).toLowerCase().includes(q)));
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.key === sort.key);
    const value = column?.sortValue ?? column?.text;
    if (!value) return filtered;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * factor;
    });
  }, [filtered, columns, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * pageSize, current * pageSize + pageSize);

  return {
    query,
    search: (text: string) => {
      setQuery(text);
      setPage(0);
    },
    sort,
    toggleSort: (key: string) =>
      setSort((s) => (s?.key === key ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' })),
    sorted,
    pages,
    current,
    setPage,
    visible,
  };
}

type TableRows<T> = ReturnType<typeof useTableRows<T>>;

const alignItems = (align: Column<unknown>['align']) =>
  align === 'right' ? ('flex-end' as const) : align === 'center' ? ('center' as const) : ('flex-start' as const);

function Toolbar<T>({ table, searchPlaceholder, toolbar }: { table: TableRows<T>; searchPlaceholder?: string; toolbar?: ReactNode }) {
  if (!searchPlaceholder && !toolbar) return null;
  return (
    <View style={styles.toolbar}>
      {searchPlaceholder ? (
        <TextField
          placeholder={searchPlaceholder}
          value={table.query}
          onChangeText={table.search}
          containerStyle={styles.search}
          accessibilityLabel={searchPlaceholder}
        />
      ) : null}
      {toolbar}
    </View>
  );
}

type CellStyle = StyleProp<ViewStyle>[];

function HeaderCell<T>({ column, table, style }: { column: Column<T>; table: TableRows<T>; style: CellStyle }) {
  const { colors } = useTheme();
  const sortable = !!(column.sortValue ?? column.text);
  const active = table.sort?.key === column.key;
  const arrow = active ? (
    <Icon name={table.sort?.direction === 'asc' ? 'chevron-up' : 'chevron-down'} size={14} color={colors.text} />
  ) : null;
  return (
    <Pressable
      disabled={!sortable}
      onPress={() => table.toggleSort(column.key)}
      accessibilityRole={sortable ? 'button' : undefined}
      accessibilityLabel={sortable ? `Sort by ${column.title}` : column.title}
      style={[...style, sortable && styles.sortable]}
    >
      {column.subColumns ? (
        <View style={styles.groupHeader}>
          <View style={[styles.groupTitle, { borderBottomColor: colors.border }]}>
            <Text variant="label" muted={!active} numberOfLines={1}>
              {column.title}
            </Text>
            {arrow}
          </View>
          <View style={styles.split}>
            {column.subColumns.map((label, i) => (
              <View key={label} style={[styles.splitPart, i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border }]}>
                <Text variant="small" muted numberOfLines={1}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.headerCell}>
          <Text variant="label" muted={!active} numberOfLines={2} style={styles.shrink}>
            {column.title}
          </Text>
          {arrow}
        </View>
      )}
    </Pressable>
  );
}

function BodyCell<T>({ column, row, style, lines }: { column: Column<T>; row: T; style: CellStyle; lines: number }) {
  return (
    <View style={style}>
      {column.render ? (
        column.render(row)
      ) : (
        <Text numberOfLines={lines} align={column.align} numeric={column.align === 'right'}>
          {column.text?.(row) ?? ''}
        </Text>
      )}
    </View>
  );
}

/**
 * One cell of a column with subColumns: a value under each label, or a single
 * value across the whole column (an accessory has units, not full and empty).
 */
export function SplitCell({ values, muted }: { values: string[]; muted?: boolean[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.split}>
      {values.map((value, i) => (
        <View key={i} style={[styles.splitPart, i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border }]}>
          <Text numeric numberOfLines={1} muted={muted?.[i]}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A column with Full and Empty under it has a line on its left. The last of a
 * run of them also gets one on its right, where a plain column follows.
 */
function closesGroup<T>(column: Column<T>, next: Column<T> | undefined): boolean {
  return !!column.subColumns && !!next && !next.subColumns;
}

/** SGM Desk: the whole table, scrolling sideways when the window is narrower than minWidth. */
function ScrollingTable<T>(props: DataTableProps<T>) {
  const { columns, rowKey, pageSize = 15, searchPlaceholder, onRowPress, emptyText = 'Nothing to show yet.', minWidth = 640, toolbar } = props;
  const { colors } = useTheme();
  const table = useTableRows(props, pageSize);
  const [viewportWidth, setViewportWidth] = useState(0);
  const { sorted, current, pages, visible } = table;

  const cellStyle = (c: Column<T>, next: Column<T> | undefined): CellStyle => [
    styles.cell,
    c.width ? { width: c.width } : { flex: c.flex ?? 1 },
    c.subColumns ? [styles.groupCell, { borderLeftColor: colors.border }] : { alignItems: alignItems(c.align) },
    closesGroup(c, next) && [styles.groupEnd, { borderRightColor: colors.border }],
  ];

  return (
    <View style={styles.container}>
      <Toolbar table={table} searchPlaceholder={searchPlaceholder} toolbar={toolbar} />

      <ScrollView horizontal onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}>
        {/* As wide as the space it has, but never narrower than minWidth: long text is cut with "…" instead of widening the table. */}
        <View style={[styles.table, { width: Math.max(viewportWidth, minWidth), borderColor: colors.border }]}>
          <View style={[styles.row, styles.headerRow, { backgroundColor: colors.surfaceMuted, borderBottomColor: colors.border }]}>
            {columns.map((c, i) => (
              <HeaderCell key={c.key} column={c} table={table} style={cellStyle(c, columns[i + 1])} />
            ))}
          </View>

          {visible.map((row, index) => (
            <Pressable
              key={rowKey(row)}
              disabled={!onRowPress}
              onPress={() => onRowPress?.(row)}
              accessibilityRole={onRowPress ? 'button' : undefined}
              style={({ pressed }) => [
                styles.row,
                {
                  borderBottomColor: colors.border,
                  backgroundColor: pressed ? colors.primarySoft : index % 2 === 1 ? colors.surfaceMuted : colors.surface,
                },
                onRowPress && styles.sortable,
              ]}
            >
              {columns.map((c, i) => (
                <BodyCell key={c.key} column={c} row={row} style={cellStyle(c, columns[i + 1])} lines={1} />
              ))}
            </Pressable>
          ))}

          {visible.length === 0 ? (
            <View style={styles.empty}>
              <Text muted>{table.query ? `Nothing matches “${table.query}”.` : emptyText}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {sorted.length > pageSize ? (
        <View style={styles.footer}>
          <Text variant="small" muted style={styles.footerText}>
            {current * pageSize + 1}–{Math.min(sorted.length, (current + 1) * pageSize)} of {sorted.length}
          </Text>
          <Button title="Previous" size="sm" variant="secondary" icon="chevron-back" disabled={current === 0} onPress={() => table.setPage(current - 1)} />
          <Button title="Next" size="sm" variant="secondary" icon="chevron-forward" disabled={current >= pages - 1} onPress={() => table.setPage(current + 1)} />
        </View>
      ) : null}
    </View>
  );
}

const ROW_HEIGHT = 56;
const FOOTER_HEIGHT = 44;
/** Room the page keeps around a table: the page's padding, the card's padding and title, and a line of notes. */
const PAGE_CHROME = 150;

/**
 * SGM Pocket: a table no bigger than the screen. The first column always shows;
 * the rest are shown a few at a time with the column buttons, and the rows a
 * screenful at a time with Previous and Next, which stay under the table.
 */
function FittedTable<T>(props: DataTableProps<T> & { screenHeight: number }) {
  const { columns, rowKey, searchPlaceholder, onRowPress, emptyText = 'Nothing to show yet.', toolbar, screenHeight } = props;
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [group, setGroup] = useState(0);

  const [first, ...rest] = columns;
  const firstWidth = Math.round(Math.min(Math.max(first?.width ?? width * 0.4, 110), width * 0.42, 240));
  const room = Math.max(width - firstWidth - 2, 1);

  // The other columns, packed into groups that fit next to the first column.
  const groups = useMemo(() => {
    const packed: { column: Column<T>; width: number }[][] = [];
    let currentGroup: { column: Column<T>; width: number }[] = [];
    let used = 0;
    for (const column of rest) {
      const natural = Math.min(room, Math.max(column.width ?? 110 * (column.flex ?? 1), 80));
      if (currentGroup.length > 0 && used + natural > room) {
        packed.push(currentGroup);
        currentGroup = [];
        used = 0;
      }
      currentGroup.push({ column, width: natural });
      used += natural;
    }
    if (currentGroup.length > 0) packed.push(currentGroup);
    // Each group stretches to fill the row.
    return packed.map((g) => {
      const total = g.reduce((sum, part) => sum + part.width, 0);
      return g.map((part) => ({ ...part, width: Math.floor((part.width * room) / total) }));
    });
  }, [rest, room]);

  const shownGroup = Math.min(group, Math.max(groups.length - 1, 0));
  const shown = groups[shownGroup] ?? [];
  const paged = groups.length > 1;
  const grouped = columns.some((c) => c.subColumns);
  // Wide enough (a phone on its side): the column and row buttons share one line.
  const sideBySide = width >= 560;

  const fixedHeight =
    PAGE_CHROME +
    (searchPlaceholder || toolbar ? 56 : 0) +
    (grouped ? 52 : 40) +
    FOOTER_HEIGHT * (paged && !sideBySide ? 2 : 1) +
    spacing.md * 2;
  // Rows that fit with the card's title and notes above. A short screen (a
  // phone on its side) can't show those too, so there the table alone fits.
  const withChrome = Math.floor((screenHeight - fixedHeight) / ROW_HEIGHT);
  const tableOnly = Math.floor((screenHeight - fixedHeight + PAGE_CHROME - spacing.md) / ROW_HEIGHT);
  const pageSize = Math.min(25, withChrome >= 3 ? withChrome : Math.max(2, tableOnly));
  const table = useTableRows(props, pageSize);
  const { sorted, current, pages, visible } = table;

  const cellStyle = (c: Column<T>, cellWidth: number, next?: Column<T>): CellStyle => [
    styles.cell,
    styles.fittedCell,
    { width: cellWidth },
    c.subColumns ? [styles.groupCell, { borderLeftColor: colors.border }] : { alignItems: alignItems(c.align) },
    closesGroup(c, next) && [styles.groupEnd, { borderRightColor: colors.border }],
  ];
  const firstStyle = (c: Column<T>): CellStyle => [...cellStyle(c, firstWidth), styles.pinned, { borderRightColor: colors.border }];

  const firstShown = shown.length ? rest.indexOf(shown[0].column) + 2 : 1;
  const lastShown = shown.length ? rest.indexOf(shown[shown.length - 1].column) + 2 : 1;

  return (
    <View style={styles.container}>
      <Toolbar table={table} searchPlaceholder={searchPlaceholder} toolbar={toolbar} />

      <View style={[styles.table, { borderColor: colors.border }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <View style={[styles.row, styles.headerRow, { backgroundColor: colors.surfaceMuted, borderBottomColor: colors.border }]}>
          {first ? <HeaderCell column={first} table={table} style={firstStyle(first)} /> : null}
          {shown.map(({ column, width: w }, i) => (
            <HeaderCell key={column.key} column={column} table={table} style={cellStyle(column, w, shown[i + 1]?.column)} />
          ))}
        </View>

        {visible.map((row, index) => (
          <Pressable
            key={rowKey(row)}
            disabled={!onRowPress}
            onPress={() => onRowPress?.(row)}
            accessibilityRole={onRowPress ? 'button' : undefined}
            style={({ pressed }) => [
              styles.row,
              styles.fittedRow,
              {
                borderBottomColor: colors.border,
                backgroundColor: pressed ? colors.primarySoft : index % 2 === 1 ? colors.surfaceMuted : colors.surface,
              },
            ]}
          >
            {first ? <BodyCell column={first} row={row} style={firstStyle(first)} lines={2} /> : null}
            {shown.map(({ column, width: w }, i) => (
              <BodyCell key={column.key} column={column} row={row} style={cellStyle(column, w, shown[i + 1]?.column)} lines={2} />
            ))}
          </Pressable>
        ))}

        {visible.length === 0 ? (
          <View style={styles.empty}>
            <Text muted>{table.query ? `Nothing matches “${table.query}”.` : emptyText}</Text>
          </View>
        ) : pages > 1 && visible.length < pageSize ? (
          // The last page keeps the table's height, so the buttons stay where they were.
          <View style={{ height: (pageSize - visible.length) * ROW_HEIGHT }} />
        ) : null}
      </View>

      <View style={sideBySide ? styles.footersSideBySide : styles.container}>
        {paged ? (
          <View style={[styles.footer, sideBySide && styles.fill]}>
            <PagerButton icon="chevron-back" label="Show the columns to the left" disabled={shownGroup === 0} onPress={() => setGroup(shownGroup - 1)} />
            <Text variant="small" muted align="center" style={styles.footerText}>
              {firstShown === lastShown ? `Column ${firstShown}` : `Columns ${firstShown}–${lastShown}`} of {columns.length}
            </Text>
            <PagerButton
              icon="chevron-forward"
              label="Show the columns to the right"
              disabled={shownGroup >= groups.length - 1}
              onPress={() => setGroup(shownGroup + 1)}
            />
          </View>
        ) : null}
        <View style={[styles.footer, sideBySide && styles.fill]}>
          <PagerButton icon="chevron-up" label="Previous rows" disabled={current === 0} onPress={() => table.setPage(current - 1)} />
          <Text variant="small" muted align="center" style={styles.footerText}>
            {sorted.length === 0 ? 'No rows' : `Rows ${current * pageSize + 1}–${Math.min(sorted.length, (current + 1) * pageSize)} of ${sorted.length}`}
          </Text>
          <PagerButton icon="chevron-down" label="Next rows" disabled={current >= pages - 1} onPress={() => table.setPage(current + 1)} />
        </View>
      </View>
    </View>
  );
}

function PagerButton({ icon, label, disabled, onPress }: { icon: IconName; label: string; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pager,
        { borderColor: colors.border, backgroundColor: pressed ? colors.surfaceMuted : colors.surface, opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Icon name={icon} size={20} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pager: { width: 52, height: 40, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  container: { gap: spacing.md },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  search: { flexGrow: 1, flexBasis: 240, maxWidth: 420 },
  table: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  fittedRow: { height: ROW_HEIGHT, minHeight: ROW_HEIGHT },
  headerRow: { minHeight: 38, alignItems: 'stretch' },
  headerCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cell: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, justifyContent: 'center' },
  fittedCell: { paddingHorizontal: spacing.sm, alignSelf: 'stretch' },
  pinned: { borderRightWidth: StyleSheet.hairlineWidth },
  groupCell: { paddingHorizontal: 0, paddingVertical: 0, alignSelf: 'stretch', alignItems: 'stretch', borderLeftWidth: StyleSheet.hairlineWidth },
  groupEnd: { borderRightWidth: StyleSheet.hairlineWidth },
  groupHeader: { flex: 1 },
  groupTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  split: { flex: 1, flexDirection: 'row' },
  splitPart: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.sm, paddingVertical: 4 },
  shrink: { flexShrink: 1 },
  sortable: { cursor: 'pointer' },
  empty: { padding: spacing.xl, alignItems: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  footersSideBySide: { flexDirection: 'row', gap: spacing.xl },
  footerText: { flex: 1 },
});

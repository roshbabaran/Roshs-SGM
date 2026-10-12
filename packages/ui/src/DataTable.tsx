import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';
import { TextField } from './TextField';
import { spacing, useTheme } from './theme';

export interface Column<T> {
  key: string;
  title: string;
  /** Fixed width in pixels; otherwise the column shares space using `flex`. */
  width?: number;
  flex?: number;
  align?: 'left' | 'right' | 'center';
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

/** A sortable, searchable, paged table that works with a mouse and on a phone. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  pageSize = 15,
  searchPlaceholder,
  onRowPress,
  emptyText = 'Nothing to show yet.',
  initialSort,
  minWidth = 640,
  toolbar,
}: DataTableProps<T>) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(initialSort ?? null);
  const [page, setPage] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);

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

  const toggleSort = (key: string) => {
    setSort((s) => (s?.key === key ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' }));
  };

  const cellStyle = (c: Column<T>) => [
    styles.cell,
    c.width ? { width: c.width } : { flex: c.flex ?? 1 },
    { alignItems: c.align === 'right' ? ('flex-end' as const) : c.align === 'center' ? ('center' as const) : ('flex-start' as const) },
  ];

  return (
    <View style={styles.container}>
      {searchPlaceholder || toolbar ? (
        <View style={styles.toolbar}>
          {searchPlaceholder ? (
            <TextField
              placeholder={searchPlaceholder}
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setPage(0);
              }}
              containerStyle={styles.search}
              accessibilityLabel={searchPlaceholder}
            />
          ) : null}
          {toolbar}
        </View>
      ) : null}

      <ScrollView horizontal onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}>
        {/* As wide as the space it has, but never narrower than minWidth: long text is cut with "…" instead of widening the table. */}
        <View style={[styles.table, { width: Math.max(viewportWidth, minWidth), borderColor: colors.border }]}>
          <View style={[styles.row, styles.headerRow, { backgroundColor: colors.surfaceMuted, borderBottomColor: colors.border }]}>
            {columns.map((c) => {
              const sortable = !!(c.sortValue ?? c.text);
              const active = sort?.key === c.key;
              return (
                <Pressable
                  key={c.key}
                  disabled={!sortable}
                  onPress={() => toggleSort(c.key)}
                  accessibilityRole={sortable ? 'button' : undefined}
                  accessibilityLabel={sortable ? `Sort by ${c.title}` : c.title}
                  style={[cellStyle(c), sortable && styles.sortable]}
                >
                  <View style={styles.headerCell}>
                    <Text variant="label" muted={!active}>
                      {c.title}
                    </Text>
                    {active ? (
                      <Icon name={sort.direction === 'asc' ? 'chevron-up' : 'chevron-down'} size={14} color={colors.text} />
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
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
              {columns.map((c) => (
                <View key={c.key} style={cellStyle(c)}>
                  {c.render ? (
                    c.render(row)
                  ) : (
                    <Text numberOfLines={1} align={c.align} numeric={c.align === 'right'}>
                      {c.text?.(row) ?? ''}
                    </Text>
                  )}
                </View>
              ))}
            </Pressable>
          ))}

          {visible.length === 0 ? (
            <View style={styles.empty}>
              <Text muted>{query ? `Nothing matches “${query}”.` : emptyText}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {sorted.length > pageSize ? (
        <View style={styles.footer}>
          <Text variant="small" muted style={styles.footerText}>
            {current * pageSize + 1}–{Math.min(sorted.length, (current + 1) * pageSize)} of {sorted.length}
          </Text>
          <Button title="Previous" size="sm" variant="secondary" icon="chevron-back" disabled={current === 0} onPress={() => setPage(current - 1)} />
          <Button title="Next" size="sm" variant="secondary" icon="chevron-forward" disabled={current >= pages - 1} onPress={() => setPage(current + 1)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  search: { flexGrow: 1, flexBasis: 240, maxWidth: 420 },
  table: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 44 },
  headerRow: { minHeight: 38 },
  headerCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cell: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, justifyContent: 'center' },
  sortable: { cursor: 'pointer' },
  empty: { padding: spacing.xl, alignItems: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  footerText: { flex: 1 },
});

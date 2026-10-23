import { type AgedPart, type AgeGroup, type AgeGroupKey } from '@sgm/core';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { PagedList } from './PagedList';
import { Text } from './Text';
import { radius, spacing, useTheme } from './theme';

/**
 * One blue, lighter for the newest and darker for the oldest (lighter for the
 * oldest on a dark screen, where light stands out). Both ramps pass the
 * ordinal checks against their surface.
 */
const AGE_COLORS: Record<'light' | 'dark', Record<AgeGroupKey, string>> = {
  light: { week: '#86b6ef', month: '#3987e5', twoMonths: '#1c5cab', older: '#0d366b' },
  dark: { week: '#184f95', month: '#2a78d6', twoMonths: '#6da7ec', older: '#b7d3f6' },
};

/**
 * What is owed, or out, split by how long ago: one bar in four parts, a key
 * that doubles as buttons, and the customers in the chosen group (the oldest
 * group that has any, to begin with).
 */
export function AgeChart({
  groups,
  formatValue,
  detail,
  emptyText,
}: {
  groups: AgeGroup[];
  formatValue: (value: number) => string;
  /** The line under a customer's name, like "since Oct 3". */
  detail: (part: AgedPart) => string;
  emptyText: string;
}) {
  const { colors, dark } = useTheme();
  const palette = AGE_COLORS[dark ? 'dark' : 'light'];
  const [chosen, setChosen] = useState<AgeGroupKey | null>(null);
  // Four across when they fit, otherwise two by two, so none sits alone on a row.
  const [keyWidth, setKeyWidth] = useState(0);
  const across = keyWidth >= 4 * 100 + 3 * spacing.sm ? 4 : 2;
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  const filled = groups.filter((g) => g.total > 0);
  const open = groups.find((g) => g.key === chosen && g.total > 0) ?? filled.at(-1);

  if (total <= 0) return <Text muted>{emptyText}</Text>;
  return (
    <View style={styles.root}>
      <View
        accessible
        accessibilityLabel={`Stacked bar: ${groups.map((g) => `${g.label} ${formatValue(g.total)}`).join(', ')}`}
        style={styles.bar}
      >
        {filled.map((g, i) => (
          <View
            key={g.key}
            style={[
              styles.segment,
              { flexGrow: g.total, backgroundColor: palette[g.key] },
              i === filled.length - 1 && styles.lastSegment,
            ]}
          />
        ))}
      </View>
      <View style={styles.key} onLayout={(event) => setKeyWidth(event.nativeEvent.layout.width)}>
        {groups.map((g) => {
          const active = g.key === open?.key;
          return (
            <Pressable
              key={g.key}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: g.total <= 0 }}
              accessibilityLabel={`${g.label}: ${formatValue(g.total)}, ${g.parts.length} ${g.parts.length === 1 ? 'customer' : 'customers'}. Show who.`}
              disabled={g.total <= 0}
              onPress={() => setChosen(g.key)}
              style={({ pressed }) => [
                styles.keyItem,
                { flexBasis: across === 4 ? 0 : '40%' },
                {
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primarySoft : pressed ? colors.surfaceMuted : colors.surface,
                },
              ]}
            >
              <View style={styles.keyLabel}>
                <View style={[styles.swatch, { backgroundColor: palette[g.key] }]} />
                <Text variant="small" muted numberOfLines={1}>
                  {g.label}
                </Text>
              </View>
              <Text weight="600" numeric numberOfLines={1}>
                {formatValue(g.total)}
              </Text>
              <Text variant="small" muted numberOfLines={1}>
                {g.parts.length === 0 ? 'None' : `${g.parts.length} ${g.parts.length === 1 ? 'customer' : 'customers'}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {open ? (
        <View>
          <Text variant="label">{`${open.label}: oldest first`}</Text>
          <PagedList
            items={open.parts}
            keyOf={(part) => `${part.customerId}:${part.productId ?? ''}`}
            renderItem={(part) => (
              <View style={[styles.row, { borderBottomColor: colors.border }]}>
                <View style={styles.flex}>
                  <Text numberOfLines={1}>{part.customerName}</Text>
                  <Text variant="small" muted numberOfLines={2}>
                    {detail(part)}
                  </Text>
                </View>
                <Text weight="600" numeric>
                  {formatValue(part.value)}
                </Text>
              </View>
            )}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  // Square where the bar starts, rounded at its end; the 2px gaps between the parts are the card showing through.
  bar: { flexDirection: 'row', height: 20, gap: 2 },
  segment: { flexBasis: 0, minWidth: 4 },
  lastSegment: { borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  key: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  keyItem: { flexGrow: 1, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2, cursor: 'pointer' },
  keyLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  flex: { flex: 1 },
});

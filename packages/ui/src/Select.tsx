import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Checkbox } from './Basics';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { Text } from './Text';
import { TextField } from './TextField';
import { radius, spacing, useTheme } from './theme';

export interface SelectOption<V extends string> {
  label: string;
  value: V;
  hint?: string;
}

export interface SelectProps<V extends string> {
  label?: string;
  value: V | '';
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  /** Always show the search box; long lists get one anyway. */
  searchable?: boolean;
  searchPlaceholder?: string;
}

/** Options whose name or hint has the search text in it. */
function matching<V extends string>(options: SelectOption<V>[], query: string): SelectOption<V>[] {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.label.toLowerCase().includes(q) || !!o.hint?.toLowerCase().includes(q)) : options;
}

/** A field that opens a list to pick from. Long lists get a search box. */
export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  error,
  disabled,
  searchable,
  searchPlaceholder = 'Search',
}: SelectProps<V>) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((o) => o.value === value);
  const shown = matching(options, query);

  const pick = (option: SelectOption<V>) => {
    onChange(option.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <View style={styles.container}>
      {label ? <Text variant="label">{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${selected?.label ?? 'not chosen'}` : selected?.label}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[
          styles.field,
          {
            borderColor: error ? colors.danger : colors.border,
            borderWidth: error ? 2 : 1,
            backgroundColor: disabled ? colors.surfaceMuted : colors.surface,
          },
        ]}
      >
        <Text style={styles.value} muted={!selected} numberOfLines={1}>
          {selected?.label ?? placeholder}
        </Text>
        {disabled ? null : <Icon name="chevron-down" size={16} color={colors.textMuted} />}
      </Pressable>
      {error ? (
        <Text variant="small" color={colors.danger}>
          {error}
        </Text>
      ) : null}

      <Dialog visible={open} title={label ?? 'Choose'} onClose={() => setOpen(false)} width={440}>
        {searchable || options.length > 7 ? (
          <TextField placeholder={searchPlaceholder} accessibilityLabel={searchPlaceholder} value={query} onChangeText={setQuery} autoFocus />
        ) : null}
        <View>
          {shown.map((option) => {
            const active = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => pick(option)}
                style={({ pressed }) => [
                  styles.option,
                  { backgroundColor: active ? colors.primarySoft : pressed ? colors.surfaceMuted : 'transparent' },
                ]}
              >
                <View style={styles.optionText}>
                  <Text weight={active ? '600' : '400'}>{option.label}</Text>
                  {option.hint ? (
                    <Text variant="small" muted>
                      {option.hint}
                    </Text>
                  ) : null}
                </View>
                {active ? <Icon name="checkmark" color={colors.primary} /> : null}
              </Pressable>
            );
          })}
          {shown.length === 0 ? <Text muted>Nothing matches “{query}”.</Text> : null}
        </View>
      </Dialog>
    </View>
  );
}

export interface MultiSelectProps<V extends string> {
  label?: string;
  /** The chosen values; null means everything (the "All" box). */
  value: V[] | null;
  options: SelectOption<V>[];
  onChange: (value: V[] | null) => void;
  /** What "everything" is called: "All customers". */
  allLabel: string;
  /** What one chosen value is called in the summary: "customer". */
  noun: string;
  /** Always show the search box; long lists get one anyway. */
  searchable?: boolean;
  searchPlaceholder?: string;
}

/** A dropdown of checkboxes: "All", or any of the options. Long lists get a search box. */
export function MultiSelect<V extends string>({
  label,
  value,
  options,
  onChange,
  allLabel,
  noun,
  searchable,
  searchPlaceholder = 'Search',
}: MultiSelectProps<V>) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const chosen = new Set(value ?? []);
  const shown = matching(options, query);
  const summary =
    value === null
      ? allLabel
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? `1 ${noun}`)
        : `${value.length} ${noun}s`;

  const toggle = (option: V, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(option);
    else next.delete(option);
    onChange(Array.from(next));
  };

  return (
    <View style={styles.container}>
      {label ? <Text variant="label">{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${summary}` : summary}
        onPress={() => setOpen(true)}
        style={[styles.field, { borderColor: value?.length === 0 ? colors.danger : colors.border, borderWidth: 1, backgroundColor: colors.surface }]}
      >
        <Text style={styles.value} numberOfLines={1}>
          {value?.length === 0 ? `No ${noun}s chosen` : summary}
        </Text>
        <Icon name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>

      <Dialog
        visible={open}
        title={label ?? 'Choose'}
        onClose={() => setOpen(false)}
        width={440}
        actions={<Button title="Done" onPress={() => setOpen(false)} disabled={value?.length === 0} />}
      >
        <Checkbox label={allLabel} checked={value === null} onChange={(on) => onChange(on ? null : [])} />
        {searchable || options.length > 7 ? (
          <TextField placeholder={searchPlaceholder} accessibilityLabel={searchPlaceholder} value={query} onChangeText={setQuery} />
        ) : null}
        <View style={[styles.checks, { borderTopColor: colors.border }]}>
          {shown.map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              hint={option.hint}
              checked={value === null || chosen.has(option.value)}
              onChange={(on) => (value === null ? onChange(options.map((o) => o.value).filter((v) => v !== option.value)) : toggle(option.value, on))}
            />
          ))}
          {shown.length === 0 ? <Text muted>Nothing matches “{query}”.</Text> : null}
        </View>
      </Dialog>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  checks: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.sm },
  field: {
    minHeight: 42,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    cursor: 'pointer',
  },
  value: { flex: 1 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    cursor: 'pointer',
  },
  optionText: { flex: 1, gap: 2 },
});

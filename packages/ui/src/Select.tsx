import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

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
}

/** A field that opens a list to pick from. Long lists get a search box. */
export function Select<V extends string>({ label, value, options, onChange, placeholder = 'Choose…', error, disabled }: SelectProps<V>) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

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
        {options.length > 7 ? <TextField placeholder="Search" value={query} onChangeText={setQuery} autoFocus /> : null}
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

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
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

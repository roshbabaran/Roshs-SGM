import DateTimePicker from '@react-native-community/datetimepicker';
import { formatDay, localDay, parseDay } from '@sgm/core';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Icon } from './Icon';
import { Text } from './Text';
import { radius, spacing, useTheme } from './theme';

export interface DateFieldProps {
  label?: string;
  /** 'YYYY-MM-DD' */
  value: string;
  onChange: (day: string) => void;
  error?: string;
  /** Latest selectable day, 'YYYY-MM-DD'. */
  max?: string;
}

/** Phones: the system date picker. The desktop version is DateField.web.tsx. */
export function DateField({ label, value, onChange, error, max }: DateFieldProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.container}>
      {label ? <Text variant="label">{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label ?? 'Date'}: ${value}`}
        onPress={() => setOpen(true)}
        style={[styles.field, { borderColor: error ? colors.danger : colors.border, backgroundColor: colors.surface }]}
      >
        <Icon name="calendar-outline" color={colors.textMuted} />
        <Text>{value ? `${formatDay(value)}, ${value.slice(0, 4)}` : 'Choose a date'}</Text>
      </Pressable>
      {error ? (
        <Text variant="small" color={colors.danger}>
          {error}
        </Text>
      ) : null}
      {open ? (
        <DateTimePicker
          value={value ? parseDay(value) : new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          maximumDate={max ? parseDay(max) : undefined}
          onChange={(event, date) => {
            setOpen(false);
            if (event.type === 'set' && date) onChange(localDay(date));
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  field: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});

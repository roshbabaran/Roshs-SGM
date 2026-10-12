import { StyleSheet, View } from 'react-native';

import type { DateFieldProps } from './DateField';
import { Text } from './Text';
import { fontSize, radius, spacing, useTheme } from './theme';

/** Desktop and browser: the browser's own date input, which also accepts typing. */
export function DateField({ label, value, onChange, error, max }: DateFieldProps) {
  const { colors, dark } = useTheme();
  return (
    <View style={styles.container}>
      {label ? <Text variant="label">{label}</Text> : null}
      <input
        type="date"
        aria-label={label ?? 'Date'}
        value={value}
        max={max}
        onChange={(event) => {
          if (event.target.value) onChange(event.target.value);
        }}
        style={{
          height: 42,
          boxSizing: 'border-box',
          borderRadius: radius.md,
          border: `${error ? 2 : 1}px solid ${error ? colors.danger : colors.border}`,
          padding: `0 ${spacing.md}px`,
          fontSize: fontSize.md,
          fontFamily: 'inherit',
          color: colors.text,
          backgroundColor: colors.surface,
          colorScheme: dark ? 'dark' : 'light',
        }}
      />
      {error ? (
        <Text variant="small" color={colors.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
});

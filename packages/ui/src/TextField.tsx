import { useState, type Ref } from 'react';
import { Platform, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';

import { Text } from './Text';
import { fontSize, radius, spacing, useTheme } from './theme';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  hint?: string;
  /** Shown inside the box before the text, e.g. "₱". */
  prefix?: string;
  containerStyle?: StyleProp<ViewStyle>;
  ref?: Ref<TextInput>;
}

/** The box's border shows focus, so the browser's own focus ring is turned off (web only). */
const noFocusRing = Platform.select<TextStyle>({ web: { outlineStyle: 'none' } as unknown as TextStyle, default: {} });

export function TextField({ label, error, hint, prefix, containerStyle, ref, onFocus, onBlur, multiline, ...rest }: TextFieldProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error ? colors.danger : focused ? colors.primary : colors.border;

  return (
    <View style={[styles.container, containerStyle]}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View
        style={[
          styles.box,
          multiline && styles.multilineBox,
          { borderColor, backgroundColor: colors.surface, borderWidth: focused || error ? 2 : 1 },
        ]}
      >
        {prefix ? (
          <Text muted style={styles.prefix}>
            {prefix}
          </Text>
        ) : null}
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          multiline={multiline}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[styles.input, multiline && styles.multilineInput, noFocusRing, { color: colors.text }]}
          {...rest}
        />
      </View>
      {error ? (
        <Text variant="small" color={colors.danger}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="small" muted>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  box: {
    minHeight: 42,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  multilineBox: { alignItems: 'flex-start', paddingVertical: spacing.sm },
  prefix: { marginRight: spacing.xs },
  input: { flex: 1, fontSize: fontSize.md, paddingVertical: spacing.sm, minWidth: 0 },
  multilineInput: { minHeight: 64, textAlignVertical: 'top' },
});

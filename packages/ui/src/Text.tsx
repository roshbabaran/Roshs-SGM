import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { fontSize, monoFont, useTheme } from './theme';

type Variant = 'title' | 'heading' | 'subheading' | 'body' | 'label' | 'small' | 'mono';

const variants: Record<Variant, TextStyle> = {
  title: { fontSize: fontSize.xxl, fontWeight: '700' },
  heading: { fontSize: fontSize.xl, fontWeight: '700' },
  subheading: { fontSize: fontSize.lg, fontWeight: '600' },
  body: { fontSize: fontSize.md },
  label: { fontSize: fontSize.sm, fontWeight: '600' },
  small: { fontSize: fontSize.xs },
  mono: { fontSize: fontSize.sm, fontFamily: monoFont },
};

export interface TextProps extends RNTextProps {
  variant?: Variant;
  muted?: boolean;
  color?: string;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
  /** Lines up digits so amounts in a column line up. */
  numeric?: boolean;
}

export function Text({ variant = 'body', muted, color, weight, align, numeric, style, ...rest }: TextProps) {
  const { colors } = useTheme();
  return (
    <RNText
      style={[
        variants[variant],
        { color: color ?? (muted ? colors.textMuted : colors.text) },
        weight ? { fontWeight: weight } : null,
        align ? { textAlign: align } : null,
        numeric ? { fontVariant: ['tabular-nums'] } : null,
        style,
      ]}
      {...rest}
    />
  );
}

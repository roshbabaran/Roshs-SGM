import { useState } from 'react';
import { View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { Text } from './Text';
import { useTheme } from './theme';

export interface BarDatum {
  label: string;
  value: number;
}

/** Rounds up to 1, 2 or 5 times a power of ten so axis lines land on tidy numbers. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((s) => s * power >= value) ?? 10;
  return step * power;
}

export function BarChart({
  data,
  height = 220,
  formatValue = (v) => v.toString(),
  formatAxis,
  accessibilityLabel,
}: {
  data: BarDatum[];
  height?: number;
  formatValue?: (value: number) => string;
  formatAxis?: (value: number) => string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const axis = formatAxis ?? formatValue;

  const left = 64;
  const right = 8;
  const top = 22;
  const bottom = 26;
  const plotWidth = Math.max(0, width - left - right);
  const plotHeight = height - top - bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const slot = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = Math.min(48, slot * 0.6);
  const showValues = data.length <= 14;

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={
        accessibilityLabel ?? `Bar chart: ${data.map((d) => `${d.label} ${formatValue(d.value)}`).join(', ')}`
      }
    >
      {width > 0 ? (
        <Svg width={width} height={height}>
          {[0, 0.5, 1].map((fraction) => {
            const y = top + plotHeight * (1 - fraction);
            return (
              <Line key={fraction} x1={left} x2={width - right} y1={y} y2={y} stroke={colors.border} strokeWidth={1} />
            );
          })}
          {[0, 0.5, 1].map((fraction) => (
            <SvgText
              key={`label-${fraction}`}
              x={left - 8}
              y={top + plotHeight * (1 - fraction) + 4}
              fontSize={11}
              fill={colors.textMuted}
              textAnchor="end"
            >
              {axis(max * fraction)}
            </SvgText>
          ))}
          {data.map((d, i) => {
            const barHeight = (d.value / max) * plotHeight;
            const x = left + slot * i + (slot - barWidth) / 2;
            const y = top + plotHeight - barHeight;
            return (
              <G key={d.label}>
                <Rect x={x} y={y} width={barWidth} height={Math.max(0, barHeight)} rx={4} fill={colors.primary} />
                {showValues && d.value > 0 ? (
                  <SvgText x={x + barWidth / 2} y={y - 6} fontSize={11} fill={colors.text} textAnchor="middle">
                    {axis(d.value)}
                  </SvgText>
                ) : null}
                <SvgText x={x + barWidth / 2} y={height - 8} fontSize={11} fill={colors.textMuted} textAnchor="middle">
                  {d.label}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
      {data.length === 0 ? <Text muted>No data for these dates.</Text> : null}
    </View>
  );
}

import { useRef, useState } from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { niceMax, type BarDatum } from './BarChart';
import { Text } from './Text';
import { useTheme } from './theme';

/**
 * One value over time, such as what a customer owed at the end of each day: a
 * line with a light wash under it and the latest value at its end. Tap or
 * click the chart to read any day.
 */
export function LineChart({
  data,
  height = 200,
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
  const [picked, setPicked] = useState<number | null>(null);
  const plot = useRef<View>(null);
  const axis = formatAxis ?? formatValue;

  const left = 64;
  const right = 16;
  const top = 26;
  const bottom = 26;
  const plotWidth = Math.max(0, width - left - right);
  const plotHeight = height - top - bottom;
  const values = data.map((d) => d.value);
  const min = Math.min(0, ...values);
  const max = niceMax(Math.max(0, ...values));
  const x = (i: number) => left + (data.length > 1 ? (plotWidth * i) / (data.length - 1) : plotWidth / 2);
  const y = (v: number) => top + plotHeight * (1 - (v - min) / (max - min));
  const points = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`);
  const line = points.length > 0 ? `M${points.join('L')}` : '';
  const area = points.length > 1 ? `${line}L${x(data.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z` : '';
  // A few dates along the bottom: the first, the last and some between.
  const step = Math.max(1, Math.ceil(data.length / 6));
  const labelled = data.map((_, i) => i).filter((i) => i === data.length - 1 || (i % step === 0 && data.length - 1 - i >= step / 2));
  const last = data.length - 1;
  const shown = picked !== null && picked <= last ? picked : null;

  // Where on the chart it was pressed, from the page position (a browser doesn't say where within the chart).
  const pick = (event: GestureResponderEvent) => {
    const { pageX } = event.nativeEvent;
    plot.current?.measure((_x, _y, _w, _h, chartX) => {
      if (data.length === 0 || plotWidth <= 0) return;
      const i = data.length > 1 ? Math.round(((pageX - chartX - left) / plotWidth) * (data.length - 1)) : 0;
      setPicked(Math.min(last, Math.max(0, i)));
    });
  };

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={accessibilityLabel ?? `Line chart: ${data.map((d) => `${d.label} ${formatValue(d.value)}`).join(', ')}`}
    >
      <Text variant="small" muted>
        {shown !== null ? `${data[shown]!.label}: ${formatValue(data[shown]!.value)}` : 'Tap or click the chart to see a day.'}
      </Text>
      {width > 0 ? (
        <Pressable ref={plot} onPress={pick} accessibilityRole="adjustable">
          <Svg width={width} height={height}>
            {[0, 0.5, 1].map((fraction) => {
              const value = min + (max - min) * fraction;
              return (
                <Line key={fraction} x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke={colors.border} strokeWidth={1} />
              );
            })}
            {[0, 0.5, 1].map((fraction) => {
              const value = min + (max - min) * fraction;
              return (
                <SvgText key={`label-${fraction}`} x={left - 8} y={y(value) + 4} fontSize={11} fill={colors.textMuted} textAnchor="end">
                  {axis(value)}
                </SvgText>
              );
            })}
            {area ? <Path d={area} fill={colors.primary} fillOpacity={0.1} /> : null}
            {line ? <Path d={line} stroke={colors.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" fill="none" /> : null}
            {shown !== null ? (
              <>
                <Line x1={x(shown)} x2={x(shown)} y1={top} y2={top + plotHeight} stroke={colors.textMuted} strokeWidth={1} />
                <Circle cx={x(shown)} cy={y(data[shown]!.value)} r={5} fill={colors.primary} stroke={colors.surface} strokeWidth={2} />
              </>
            ) : null}
            {last >= 0 ? (
              <>
                <Circle cx={x(last)} cy={y(data[last]!.value)} r={5} fill={colors.primary} stroke={colors.surface} strokeWidth={2} />
                <SvgText x={x(last)} y={y(data[last]!.value) - 10} fontSize={11} fill={colors.text} textAnchor="end">
                  {axis(data[last]!.value)}
                </SvgText>
              </>
            ) : null}
            {labelled.map((i) => (
              <SvgText
                key={`x-${i}`}
                x={x(i)}
                y={height - 8}
                fontSize={11}
                fill={colors.textMuted}
                textAnchor={i === 0 && data.length > 1 ? 'start' : i === last ? 'end' : 'middle'}
              >
                {data[i]!.label}
              </SvgText>
            ))}
          </Svg>
        </Pressable>
      ) : (
        <View style={{ height }} />
      )}
      {data.length === 0 ? <Text muted>No data for these dates.</Text> : null}
    </View>
  );
}

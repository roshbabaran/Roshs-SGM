import { paymentRows, type Receipt } from '@sgm/core';
import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { monoFont, spacing } from './theme';

const INK = '#000000';

function Line({ left, right, bold }: { left: string; right?: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.mono, styles.shrink, bold && styles.bold]} color={INK}>
        {left}
      </Text>
      {right ? (
        <Text style={[styles.mono, bold && styles.bold]} color={INK}>
          {right}
        </Text>
      ) : null}
    </View>
  );
}

function Centered({ children, bold, color = INK }: { children: string; bold?: boolean; color?: string }) {
  return (
    <Text style={[styles.mono, styles.center, bold && styles.bold]} color={color}>
      {children}
    </Text>
  );
}

function Rule() {
  return <View style={styles.rule} />;
}

/** On-screen copy of a printed receipt. Always black on white, like the paper. */
export function ReceiptPreview({ receipt }: { receipt: Receipt }) {
  return (
    <View style={styles.paper} accessibilityLabel={`Receipt ${receipt.receiptNo}, total ${receipt.total}`}>
      <Centered bold>{receipt.businessName}</Centered>
      <Centered>{receipt.address}</Centered>
      <Centered>{receipt.tin}</Centered>
      <Rule />
      <Line left={`Receipt: ${receipt.receiptNo}`} />
      <Line left={receipt.dateTime} />
      <Line left={`${receipt.locationName} / ${receipt.cashierName}`} />
      {receipt.customer ? <Line left={`Customer: ${receipt.customer}`} /> : null}
      <Rule />
      {receipt.voided ? (
        <>
          <Centered bold color="#B00020">
            *** VOIDED ***
          </Centered>
          <Rule />
        </>
      ) : null}
      {receipt.lines.map((line, i) => (
        <View key={i}>
          <Line left={line.name} />
          {line.rows.map((row, j) => (
            <Line key={j} left={`  ${row.detail}`} right={row.amount} />
          ))}
        </View>
      ))}
      <Rule />
      <Line left="TOTAL" right={receipt.total} bold />
      {paymentRows(receipt).map((row) => (
        <Line key={row.detail} left={row.detail} right={row.amount} />
      ))}
      <Rule />
      {receipt.notes.length > 0 ? (
        <>
          {receipt.notes.map((note) => (
            <Line key={note} left={note} />
          ))}
          <Rule />
        </>
      ) : null}
      {receipt.footer.map((line) => (
        <Centered key={line}>{line}</Centered>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  paper: {
    backgroundColor: '#FFFFFF',
    padding: spacing.lg,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#D0D0D0',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 340,
    gap: 1,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  mono: { fontFamily: monoFont, fontSize: 12 },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: '700' },
  center: { textAlign: 'center' },
  rule: { borderTopWidth: 1, borderStyle: 'dashed', borderColor: INK, marginVertical: 4 },
});

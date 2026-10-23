import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { PagerButton, useFitHeight } from './DataTable';
import { Text } from './Text';
import { spacing } from './theme';

/** Room a page keeps around a list on a phone: the page's padding, the card's padding and title, and a note. */
const PAGE_CHROME = 150;
const FOOTER_HEIGHT = 48;
const FIRST_GUESS_ROW_HEIGHT = 44;

/**
 * A list shown a page at a time, with Previous and Next above it once there are
 * more. On SGM Desk a page is `pageSize` rows. Inside FitTablesToScreen (SGM
 * Pocket) it is as many rows as fit on the screen, less `reserve` for whatever
 * else the card shows above the list.
 */
export function PagedList<T>({
  items,
  keyOf,
  renderItem,
  pageSize = 5,
  reserve = 0,
}: {
  items: T[];
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  pageSize?: number;
  reserve?: number;
}) {
  const fitHeight = useFitHeight();
  const [page, setPage] = useState(0);
  // The tallest row seen so far, so a page of taller rows still fits.
  const [rowHeight, setRowHeight] = useState(0);

  const fitted = fitHeight === null ? 0 : Math.floor((fitHeight - PAGE_CHROME - FOOTER_HEIGHT - reserve) / (rowHeight || FIRST_GUESS_ROW_HEIGHT));
  const size = fitHeight === null ? pageSize : Math.min(25, Math.max(3, fitted));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages - 1);
  const shown = items.slice(current * size, current * size + size);
  const range = `${current * size + 1}–${Math.min(items.length, (current + 1) * size)} of ${items.length}`;

  // The page buttons go above the list, so they stay put when a page's rows are shorter or taller.
  return (
    <View>
      {items.length <= size ? null : fitHeight === null ? (
        <View style={styles.pager}>
          <Text variant="small" muted style={styles.pagerText}>
            {range}
          </Text>
          <Button title="Previous" size="sm" variant="secondary" icon="chevron-back" disabled={current === 0} onPress={() => setPage(current - 1)} />
          <Button title="Next" size="sm" variant="secondary" icon="chevron-forward" disabled={current >= pages - 1} onPress={() => setPage(current + 1)} />
        </View>
      ) : (
        <View style={styles.pager}>
          <PagerButton icon="chevron-up" label="Previous rows" disabled={current === 0} onPress={() => setPage(current - 1)} />
          <Text variant="small" muted align="center" style={styles.pagerText}>
            {`Rows ${range}`}
          </Text>
          <PagerButton icon="chevron-down" label="Next rows" disabled={current >= pages - 1} onPress={() => setPage(current + 1)} />
        </View>
      )}
      {shown.map((item) => (
        <View
          key={keyOf(item)}
          onLayout={(event) => {
            // Read the height now: on Android the event is emptied once this handler returns, before React runs the update.
            const height = Math.ceil(event.nativeEvent.layout.height);
            setRowHeight((h) => Math.max(h, height));
          }}
        >
          {renderItem(item)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pager: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
  pagerText: { flex: 1 },
});

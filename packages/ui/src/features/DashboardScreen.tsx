import {
  addDays,
  approvesClaims,
  CLAIM_LABELS,
  cheques,
  dailyTotals,
  dayRange,
  defectiveItemText,
  formatDay,
  formatPeso,
  formatTime,
  isLowStock,
  levelOf,
  localDay,
  openTransfers,
  pendingClaims,
  returnTotals,
  salesBetween,
  seesCheques,
  sellable,
  settlesTransfersFrom,
  stockByProduct,
  transferQtyText,
  transfersToAccept,
  worksAt,
  type Claim,
  type LoanEntry,
  type Product,
  type Sale,
  type StockMovement,
} from '@sgm/core';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Card, EmptyState, ScreenHeader, StatTile } from '../Basics';
import { BarChart } from '../BarChart';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PagedList } from '../PagedList';
import { useCollection, useSyncStatus, useWork } from '../services';
import { Text } from '../Text';
import { spacing, useTheme } from '../theme';

/** Shortens peso amounts for chart labels: ₱12.5k */
export function shortPeso(centavos: number): string {
  const pesos = centavos / 100;
  if (pesos >= 1_000_000) return `₱${(pesos / 1_000_000).toFixed(1)}M`;
  if (pesos >= 1_000) return `₱${(pesos / 1_000).toFixed(pesos >= 10_000 ? 0 : 1)}k`;
  return `₱${Math.round(pesos)}`;
}

/** Where the dashboard can send someone: the app knows its own routes. */
export type DashboardLink = 'claims' | 'cheques' | 'inventory';

/** How many days ahead the owner sees post-dated cheques coming. */
const CHEQUES_AHEAD = 7;

/** Rows a dashboard list shows at a time on SGM Desk; SGM Pocket fits as many as the screen holds. */
const PAGE_SIZE = 5;

export function DashboardScreen({
  onAdjustStock,
  onOpen,
}: {
  /** Opens Inventory's stock adjustment for this product. */
  onAdjustStock?: (productId: string) => void;
  onOpen?: (link: DashboardLink) => void;
}) {
  const work = useWork();
  const sync = useSyncStatus();
  const { colors } = useTheme();
  const { data: sales } = useCollection<Sale>('sales');
  const { data: products } = useCollection<Product>('products');
  const { data: movements } = useCollection<StockMovement>('movements');
  const { data: loans } = useCollection<LoanEntry>('loans');
  const { data: claims } = useCollection<Claim>('claims');

  const today = localDay(new Date());
  const weekStart = addDays(today, -6);
  const todaySales = salesBetween(sales, today, today, work.locationId);
  const weekSales = salesBetween(sales, weekStart, today, work.locationId);
  const todayTotal = todaySales.reduce((sum, s) => sum + s.total, 0);
  const levels = stockByProduct(movements, work.locationId);
  const left = (p: Product) => sellable(p, levelOf(levels, p.id));
  // Out of stock first (in red), then the lowest.
  const alerts = products
    .filter((p) => p.active && isLowStock(p, levelOf(levels, p.id)))
    .sort((a, b) => Number(left(a) > 0) - Number(left(b) > 0) || left(a) - left(b) || a.name.localeCompare(b.name));
  const out = alerts.filter((p) => left(p) <= 0).length;
  const low = alerts.length - out;
  const chart = dailyTotals(weekSales, dayRange(weekStart, today)).map((d) => ({ label: d.label, value: d.total }));
  const recent = [...todaySales].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const canAdjust = work.can('inventory.record') && !!onAdjustStock;

  const showCheques = seesCheques(work.user);
  const comingCheques = showCheques
    ? cheques(loans).filter((c) => c.state === 'waiting' && c.cheque.cashOn <= addDays(today, CHEQUES_AHEAD) && worksAt(work.user, c.entry.locationId))
    : [];
  const showClaims = approvesClaims(work.user);
  const waiting = showClaims ? pendingClaims(claims, work.user) : [];
  // Returns and defective exchanges done here today, and those asked for today that still wait for approval.
  const todayReturns = returnTotals(claims, today, today, work.locationId);
  const todayClaims = claims
    .filter(
      (c) =>
        c.kind !== 'pickup' &&
        c.locationId === work.locationId &&
        ((c.status === 'completed' && localDay(c.decidedAt ?? c.createdAt) === today) || (c.status === 'pending' && localDay(c.createdAt) === today)),
    )
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  const waitingToday = todayClaims.filter((c) => c.status === 'pending').length;
  // Stock sent here to accept, and counts of stock sent from here to settle (by the manager or warehouse staff).
  const stockForMe = [
    ...transfersToAccept(movements, work.user, work.locationId),
    ...(settlesTransfersFrom(work.user, work.locationId)
      ? openTransfers(movements, work.locationId).filter((t) => t.state === 'mismatch' && t.fromId === work.locationId)
      : []),
  ];
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const placeName = (id: string) => work.locations.find((l) => l.id === id)?.name ?? id;
  // The returns card's tiles, so its list still fits a phone's screen under them.
  const [claimTilesHeight, setClaimTilesHeight] = useState(0);

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader title={`Good day, ${work.user?.displayName ?? ''}`} subtitle={work.location?.name ?? undefined} />
      <View style={styles.tiles}>
        <StatTile label="Sales today" value={formatPeso(todayTotal)} hint={`${todaySales.length} transactions`} icon="cash-outline" />
        <StatTile label="This week" value={formatPeso(weekSales.reduce((s, x) => s + x.total, 0))} hint={`${weekSales.length} transactions`} icon="calendar-outline" />
        <StatTile
          label="Low or out of stock"
          value={alerts.length === 0 ? '0' : `${out} out · ${low} low`}
          hint={
            out > 0
              ? `${out} item${out === 1 ? ' has' : 's have'} no stock left`
              : low > 0
                ? 'Needs stock from the depot or another branch'
                : 'All items above minimum'
          }
          icon="cube-outline"
          tone={out > 0 ? 'danger' : low > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Waiting to sync"
          value={String(sync.pending)}
          hint={sync.state === 'offline' ? 'Offline: will send when connected' : sync.pending === 0 ? 'Everything is on the server' : 'Sending soon'}
          icon="cloud-upload-outline"
          tone={sync.state === 'offline' ? 'warning' : 'neutral'}
        />
      </View>

      {waiting.length > 0 || comingCheques.length > 0 || stockForMe.length > 0 ? (
        <View style={styles.columns}>
          {stockForMe.length > 0 ? (
            <Card
              title={`Stock to accept or settle (${stockForMe.length})`}
              style={styles.sideCard}
              action={onOpen ? <Button title="Open Inventory" variant="ghost" size="sm" onPress={() => onOpen('inventory')} /> : null}
            >
              <PagedList
                items={stockForMe}
                keyOf={(t) => t.id}
                pageSize={PAGE_SIZE}
                renderItem={(t) => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!onOpen}
                    onPress={() => onOpen?.('inventory')}
                    style={[styles.listRow, { borderBottomColor: colors.border }]}
                  >
                    <Icon
                      name={t.state === 'mismatch' ? 'alert-circle-outline' : 'arrow-down-circle-outline'}
                      color={t.state === 'mismatch' ? colors.danger : colors.primary}
                    />
                    <View style={styles.flex}>
                      <Text>{productName(t.productId)}</Text>
                      <Text variant="small" muted>
                        {t.state === 'mismatch' ? `${placeName(t.toId)} counted ${t.arrived} of ${t.qty}: settle it` : `From ${placeName(t.fromId)}: count and accept it`}
                      </Text>
                    </View>
                    <Text weight="600" numeric>
                      {transferQtyText(t.qty, t.condition)}
                    </Text>
                  </Pressable>
                )}
              />
            </Card>
          ) : null}
          {waiting.length > 0 ? (
            <Card
              title={`Waiting for your approval (${waiting.length})`}
              style={styles.sideCard}
              action={onOpen ? <Button title="Open Claims" variant="ghost" size="sm" onPress={() => onOpen('claims')} /> : null}
            >
              <PagedList
                items={waiting}
                keyOf={(claim) => claim.id}
                pageSize={PAGE_SIZE}
                renderItem={(claim) => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!onOpen}
                    onPress={() => onOpen?.('claims')}
                    style={[styles.listRow, { borderBottomColor: colors.border }]}
                  >
                    <Icon name={claim.kind === 'return' ? 'return-down-back-outline' : 'construct-outline'} color={colors.warning} />
                    <View style={styles.flex}>
                      <Text>
                        {CLAIM_LABELS[claim.kind]}
                        {claim.customerName ? ` · ${claim.customerName}` : ''}
                      </Text>
                      <Text variant="small" muted>
                        {claim.kind === 'return' ? claim.items.map((i) => `${i.qty} × ${i.name}`).join(', ') : defectiveItemText(claim)}
                      </Text>
                    </View>
                    <Text weight="600" numeric>
                      {formatPeso(claim.kind === 'return' ? (claim.refund ?? 0) : (claim.charge ?? 0))}
                    </Text>
                  </Pressable>
                )}
              />
            </Card>
          ) : null}
          {comingCheques.length > 0 ? (
            <Card
              title="Post-dated cheques"
              style={styles.sideCard}
              action={onOpen ? <Button title="Open cheques" variant="ghost" size="sm" onPress={() => onOpen('cheques')} /> : null}
            >
              <PagedList
                items={comingCheques}
                keyOf={(c) => c.entry.id}
                pageSize={PAGE_SIZE}
                renderItem={(c) => {
                  const due = c.cheque.cashOn <= today;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      disabled={!onOpen}
                      onPress={() => onOpen?.('cheques')}
                      style={[styles.listRow, { borderBottomColor: colors.border }]}
                    >
                      <Icon name="document-text-outline" color={due ? colors.danger : colors.textMuted} />
                      <View style={styles.flex}>
                        <Text>{c.entry.borrowerName}</Text>
                        <Text variant="small" muted>
                          {c.cheque.bank} no. {c.cheque.number}
                        </Text>
                      </View>
                      <View style={styles.right}>
                        <Text weight="600" numeric>
                          {formatPeso(c.amount)}
                        </Text>
                        <Badge label={due ? 'Can be cashed now' : `Cash on ${formatDay(c.cheque.cashOn)}`} tone={due ? 'danger' : 'info'} />
                      </View>
                    </Pressable>
                  );
                }}
              />
            </Card>
          ) : null}
        </View>
      ) : null}

      <View style={styles.columns}>
        <Card title="Sales, last 7 days" style={styles.chartCard}>
          <BarChart data={chart} formatValue={formatPeso} formatAxis={shortPeso} />
        </Card>
        <Card title="Low and out of stock" style={styles.sideCard}>
          {alerts.length === 0 ? (
            <EmptyState icon="checkmark-circle-outline" title="Nothing is low" />
          ) : (
            <>
              <PagedList
                items={alerts}
                keyOf={(p) => p.id}
                pageSize={PAGE_SIZE}
                renderItem={(p) => {
                  const none = left(p) <= 0;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${p.name}: ${none ? 'out of stock' : `${left(p)} left`}.${canAdjust ? ' Adjust its stock.' : ''}`}
                      disabled={!canAdjust}
                      onPress={() => onAdjustStock?.(p.id)}
                      style={({ pressed }) => [
                        styles.listRow,
                        { borderBottomColor: colors.border, backgroundColor: pressed ? colors.surfaceMuted : 'transparent' },
                        canAdjust && styles.clickable,
                      ]}
                    >
                      <Text style={styles.flex} color={none ? colors.danger : undefined} weight={none ? '600' : undefined}>
                        {p.name}
                      </Text>
                      <Badge label={none ? 'Out of stock' : `${left(p)} left`} tone={none ? 'danger' : 'warning'} icon={none ? 'alert-circle-outline' : undefined} />
                      {canAdjust ? <Icon name="chevron-forward" size={16} color={colors.textMuted} /> : null}
                    </Pressable>
                  );
                }}
              />
              {canAdjust ? (
                <Text variant="small" muted>
                  Click an item to adjust its stock in Inventory.
                </Text>
              ) : null}
            </>
          )}
        </Card>
      </View>

      <Card title="Today's sales">
        {recent.length === 0 ? (
          <EmptyState icon="receipt-outline" title="No sales yet today" />
        ) : (
          <PagedList
            items={recent}
            keyOf={(sale) => sale.id}
            pageSize={PAGE_SIZE}
            renderItem={(sale) => (
              <View style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <Text muted style={styles.time}>
                  {formatTime(sale.createdAt)}
                </Text>
                <Text style={styles.flex}>
                  {sale.borrowerName ? `${sale.borrowerName}: ` : ''}
                  {sale.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}
                </Text>
                {sale.prepaid ? <Badge label="Prepaid" tone="info" /> : null}
                <Text weight="600" numeric>
                  {formatPeso(sale.total)}
                </Text>
              </View>
            )}
          />
        )}
      </Card>

      <Card
        title="Today's returns and defective exchanges"
        action={onOpen && todayClaims.length > 0 ? <Button title="Open Claims" variant="ghost" size="sm" onPress={() => onOpen('claims')} /> : null}
      >
        <View style={styles.tiles} onLayout={(event) => setClaimTilesHeight(event.nativeEvent.layout.height)}>
          <StatTile
            label="Returns"
            value={String(todayReturns.returns)}
            hint={`${formatPeso(todayReturns.refunded)} refunded`}
            icon="return-down-back-outline"
          />
          <StatTile
            label="Defective exchanges"
            value={String(todayReturns.defectives)}
            hint={`${formatPeso(todayReturns.charged)} paid by customers`}
            icon="construct-outline"
          />
          {waitingToday > 0 ? (
            <StatTile label="Waiting for approval" value={String(waitingToday)} hint="Asked for today" icon="hourglass-outline" tone="warning" />
          ) : null}
        </View>
        {todayClaims.length === 0 ? (
          <EmptyState icon="checkmark-circle-outline" title="No returns or defective exchanges today" />
        ) : (
          <PagedList
            items={todayClaims}
            keyOf={(claim) => claim.id}
            pageSize={PAGE_SIZE}
            reserve={claimTilesHeight}
            renderItem={(claim) => (
              <View style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <Text muted style={styles.time}>
                  {formatTime(claim.decidedAt ?? claim.createdAt)}
                </Text>
                <Icon name={claim.kind === 'return' ? 'return-down-back-outline' : 'construct-outline'} color={colors.textMuted} />
                <Text style={styles.flex}>
                  {CLAIM_LABELS[claim.kind]}
                  {claim.customerName ? ` · ${claim.customerName}` : ''}
                  {': '}
                  {claim.kind === 'return' ? claim.items.map((i) => `${i.qty}× ${i.name}`).join(', ') : defectiveItemText(claim)}
                </Text>
                {claim.status === 'pending' ? <Badge label="Waiting" tone="warning" /> : null}
                <Text weight="600" numeric>
                  {claim.kind === 'return' ? `-${formatPeso(claim.refund ?? 0)}` : formatPeso(claim.charge ?? 0)}
                </Text>
              </View>
            )}
          />
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  chartCard: { flexGrow: 2, flexShrink: 1, flexBasis: 480 },
  sideCard: { flexGrow: 1, flexBasis: 280 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  clickable: { cursor: 'pointer', borderRadius: 6, paddingHorizontal: spacing.xs },
  right: { alignItems: 'flex-end', gap: 2 },
  time: { width: 72 },
  flex: { flex: 1 },
});

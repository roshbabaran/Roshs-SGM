import {
  BUSINESS,
  clearLocalData,
  DemoApi,
  formatDateTime,
  RECEIPT_FOOTER,
  receiptHtml,
  ROLE_LABELS,
  saveDeviceSettings,
  seedDemoData,
  type PaperWidth,
  type Receipt,
} from '@sgm/core';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';

import { Banner, Card, ScreenHeader, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { Select } from '../Select';
import { useServices, useSyncStatus, useWork, type PrinterInfo } from '../services';
import { SyncStatusBadge } from '../SyncStatusBadge';
import { Text } from '../Text';
import { monoFont, spacing } from '../theme';
import { useToast } from '../Toast';

const SYSTEM_DIALOG = '__dialog__';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text muted style={styles.rowLabel}>
        {label}
      </Text>
      <View style={styles.rowValue}>{typeof children === 'string' ? <Text>{children}</Text> : children}</View>
    </View>
  );
}

export function SettingsScreen() {
  const services = useServices();
  const { api, sync, store, session, printer } = services;
  const work = useWork();
  const status = useSyncStatus();
  const toast = useToast();
  const settings = work.settings;
  const canChange = work.can('settings.device');
  const demo = api instanceof DemoApi ? api : null;
  const [online, setOnline] = useState(demo?.online ?? true);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let active = true;
    printer.listPrinters?.().then(
      (list) => active && setPrinters(list),
      () => active && setPrinters([]),
    );
    return () => {
      active = false;
    };
  }, [printer]);

  const save = async (patch: Partial<NonNullable<typeof settings>>) => {
    if (!settings) return;
    await saveDeviceSettings(store, { ...settings, ...patch });
  };

  const testPrint = async () => {
    const paperWidthMm = settings?.paperWidthMm ?? 58;
    const receipt: Receipt = {
      businessName: BUSINESS.name,
      address: BUSINESS.address,
      tin: BUSINESS.tin,
      receiptNo: 'TEST',
      dateTime: formatDateTime(new Date().toISOString()),
      locationName: work.location?.name ?? '',
      cashierName: work.user?.displayName ?? '',
      lines: [{ name: 'Printer test', rows: [{ detail: `${paperWidthMm} mm paper`, amount: '₱0.00' }] }],
      total: '₱0.00',
      onAccount: false,
      paymentLabel: 'Cash',
      tendered: '₱0.00',
      change: '₱0.00',
      notes: [],
      footer: RECEIPT_FOOTER,
      voided: false,
    };
    try {
      await printer.print(receiptHtml(receipt, paperWidthMm), { paperWidthMm, printerName: settings?.printerName });
      toast.show('Test receipt sent to the printer.', 'success');
    } catch (e) {
      toast.show(`Couldn't print: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const checkUpdates = async () => {
    if (!services.checkForUpdates) return;
    setChecking(true);
    try {
      setUpdateMessage(await services.checkForUpdates());
    } catch (e) {
      setUpdateMessage(`Couldn't check for updates: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const resetDemo = async () => {
    setResetting(true);
    try {
      await clearLocalData(store);
      await seedDemoData(store);
      await sync.refreshCounts();
      toast.show('Demo data reset.', 'success');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader title="Settings" subtitle={`${services.appName} ${services.appVersion}`} />
      <View style={styles.columns}>
        <Card title="This device" style={styles.card}>
          <Row label="Device ID">
            <Text style={{ fontFamily: monoFont }} selectable>
              {services.deviceId}
            </Text>
          </Row>
          <Row label="Location">
            {canChange ? (
              <Select
                value={settings?.locationId ?? ''}
                options={work.locations.map((l) => ({ label: l.name, value: l.id, hint: l.kind === 'warehouse' ? 'Warehouse' : 'Branch' }))}
                onChange={(locationId) => void save({ locationId })}
              />
            ) : (
              <Text>{work.location?.name ?? ''}</Text>
            )}
          </Row>
          <Text variant="small" muted>
            The owner approves each device once on the server using its Device ID. Only the owner can move a device to another branch.
          </Text>
        </Card>

        <Card title="Sync" style={styles.card}>
          <Row label="Status">
            <SyncStatusBadge status={status} onPress={() => void sync.syncNow()} />
          </Row>
          <Row label="Last synced">{status.lastSyncedAt ? formatDateTime(status.lastSyncedAt) : 'Not yet'}</Row>
          <Row label="Waiting">{`${status.pending} change${status.pending === 1 ? '' : 's'}`}</Row>
          <Row label="Server">{api.mode === 'demo' ? 'Demo server (built in, no real server yet)' : 'SGM API server'}</Row>
          {status.message ? <Banner tone={status.state === 'error' ? 'danger' : 'warning'}>{status.message}</Banner> : null}
          <View style={styles.actions}>
            <Button title="Sync now" icon="sync-outline" variant="secondary" onPress={() => void sync.syncNow()} loading={status.state === 'syncing'} />
          </View>
          {demo ? (
            <View style={styles.switchRow}>
              <View style={styles.flex}>
                <Text weight="600">Simulate no connection</Text>
                <Text variant="small" muted>
                  Try selling while "offline": sales are kept on this device and sent when the connection returns.
                </Text>
              </View>
              <Switch
                value={!online}
                onValueChange={(offline) => {
                  demo.online = !offline;
                  setOnline(!offline);
                  void sync.syncNow();
                }}
                accessibilityLabel="Simulate no connection"
              />
            </View>
          ) : null}
        </Card>

        <Card title="Receipt printing" style={styles.card}>
          <Row label="Paper width">
            <SegmentedControl<'58' | '80'>
              options={[
                { label: '58 mm', value: '58' },
                { label: '80 mm', value: '80' },
              ]}
              value={settings?.paperWidthMm === 80 ? '80' : '58'}
              onChange={(v) => void save({ paperWidthMm: Number(v) as PaperWidth })}
            />
          </Row>
          {printer.listPrinters ? (
            <Row label="Printer">
              <Select
                value={settings?.printerName ?? SYSTEM_DIALOG}
                options={[
                  { label: 'Ask each time (print dialog)', value: SYSTEM_DIALOG },
                  ...printers.map((p) => ({ label: p.displayName || p.name, value: p.name, hint: p.description || undefined })),
                ]}
                onChange={(name) => void save({ printerName: name === SYSTEM_DIALOG ? undefined : name })}
              />
            </Row>
          ) : (
            <Row label="Printer">Chosen in the print dialog</Row>
          )}
          <View style={styles.actions}>
            <Button title="Print test receipt" icon="print-outline" variant="secondary" onPress={testPrint} />
          </View>
        </Card>

        <Card title="Account" style={styles.card}>
          <Row label="Signed in as">{work.user ? `${work.user.displayName} (${ROLE_LABELS[work.user.role]})` : ''}</Row>
          <View style={styles.actions}>
            <Button title="Sign out" icon="log-out-outline" variant="secondary" onPress={() => void session.logout()} />
          </View>
          {services.checkForUpdates ? (
            <>
              <View style={styles.actions}>
                <Button title="Check for updates" icon="download-outline" variant="secondary" onPress={checkUpdates} loading={checking} />
              </View>
              {updateMessage ? <Text muted>{updateMessage}</Text> : null}
            </>
          ) : null}
        </Card>

        {demo && canChange ? (
          <Card title="Demo data" style={styles.card}>
            <Text muted>Puts the sample products, stock and a week of sales back, and deletes everything recorded on this device.</Text>
            <View style={styles.actions}>
              <Button title="Reset demo data" variant="danger" icon="refresh" onPress={() => setConfirmReset(true)} />
            </View>
          </Card>
        ) : null}
      </View>

      <ConfirmDialog
        visible={confirmReset}
        title="Reset demo data?"
        message="Everything recorded on this device will be deleted and the sample data put back."
        confirmLabel="Reset"
        danger
        busy={resetting}
        onConfirm={() => void resetDemo()}
        onCancel={() => setConfirmReset(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  card: { flexGrow: 1, flexBasis: 380 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  rowLabel: { width: 110 },
  rowValue: { flex: 1, minWidth: 180 },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1 },
});

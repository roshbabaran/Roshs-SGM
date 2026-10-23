import {
  canManageAccount,
  formatDateTime,
  GRANTABLE_PERMISSIONS,
  permissionsOf,
  PERMISSION_LABELS,
  put,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLES,
  type Device,
  type Location,
  type Permission,
  type Role,
  type User,
} from '@sgm/core';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Banner, Card, Checkbox, ScreenHeader, SegmentedControl } from '../Basics';
import { Button } from '../Button';
import { DataTable, type Column } from '../DataTable';
import { ConfirmDialog, Dialog } from '../Dialog';
import { Select } from '../Select';
import { useCollection, useServices, useSession, useSyncStatus, useWork } from '../services';
import { Text } from '../Text';
import { TextField } from '../TextField';
import { monoFont, spacing } from '../theme';
import { useToast } from '../Toast';

const ALL = 'all';
type Tab = 'users' | 'devices';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const OFFLINE_TEXT =
  "No connection to the SGM server. Accounts and devices are only ever changed on the server, never saved offline, so they can't be added or changed until the connection is back.";

/** Whether the server can't be reached right now: the last sync failed, or this person signed in offline. */
function useOffline(): boolean {
  const sync = useSyncStatus();
  const session = useSession();
  return sync.state === 'offline' || !!session?.offline;
}

/**
 * Users & Devices: the owner and admins create and change accounts, and
 * approve, place and remove the PCs and phones that may sign in. Changes go
 * straight to the server, so this needs a connection. Only the owner can
 * change the owner's and admins' accounts.
 */
export function UsersScreen() {
  const work = useWork();
  const { api, session, deviceId } = useServices();
  const { data: users } = useCollection<User>('users');
  const { data: locations } = useCollection<Location>('locations');
  const [tab, setTab] = useState<Tab>('users');
  const [locationId, setLocationId] = useState<string>(ALL);
  const [role, setRole] = useState<Role | typeof ALL>(ALL);
  const [editingUser, setEditingUser] = useState<User | 'new' | null>(null);
  const [editingDevice, setEditingDevice] = useState<Device | 'new' | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const offline = useOffline();

  const locationName = (id: string | null) => (id ? (locations.find((l) => l.id === id)?.name ?? id) : 'Not set');
  const locationNames = (ids: string[]) => ids.map(locationName).join(', ');
  const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? 'Unknown user') : '—');
  const roleOf = (id: string | null) => users.find((u) => u.id === id)?.role;

  const loadDevices = useCallback(async () => {
    const token = session.token();
    if (!token) return;
    setLoadingDevices(true);
    setDevicesError(null);
    try {
      setDevices(await api.listDevices(token));
    } catch (e) {
      setDevicesError(`${message(e)} The device list needs a connection to the SGM server.`);
    } finally {
      setLoadingDevices(false);
    }
  }, [api, session]);

  useEffect(() => {
    if (tab === 'devices' && devices === null) void loadDevices();
  }, [tab, devices, loadDevices]);

  const shownUsers = users.filter(
    (u) => (locationId === ALL || u.locationIds.includes(locationId)) && (role === ALL || u.role === role),
  );
  const shownDevices = (devices ?? []).filter(
    (d) => (locationId === ALL || d.locationId === locationId) && (role === ALL || roleOf(d.lastUserId) === role),
  );

  const userColumns: Column<User>[] = [
    { key: 'name', title: 'Name', flex: 1.4, text: (u) => u.displayName },
    { key: 'username', title: 'Username', flex: 1, text: (u) => u.username },
    {
      key: 'role',
      title: 'Role',
      width: 150,
      text: (u) => ROLE_LABELS[u.role],
      render: (u) => <Badge label={ROLE_LABELS[u.role]} tone={u.role === 'owner' || u.role === 'admin' ? 'info' : 'neutral'} />,
    },
    { key: 'locations', title: 'Works at', flex: 1.6, text: (u) => locationNames(u.locationIds) },
    {
      key: 'permissions',
      title: 'Can',
      flex: 3,
      text: (u) => Array.from(permissionsOf(u), (p) => PERMISSION_LABELS[p]).join(', '),
      render: (u) => (
        <Text variant="small" muted>
          {Array.from(permissionsOf(u), (p) => PERMISSION_LABELS[p]).join(' · ')}
        </Text>
      ),
    },
    {
      key: 'active',
      title: 'Status',
      width: 100,
      sortValue: (u) => (u.active ? 0 : 1),
      render: (u) => <Badge label={u.active ? 'Active' : 'Disabled'} tone={u.active ? 'success' : 'danger'} />,
    },
  ];

  const deviceColumns: Column<Device>[] = [
    { key: 'label', title: 'Device', flex: 1.3, text: (d) => `${d.label ?? 'Unnamed device'}${d.id === deviceId ? ' (this device)' : ''}` },
    {
      key: 'id',
      title: 'Device ID',
      flex: 1.6,
      text: (d) => d.id,
      render: (d) => (
        <Text variant="small" style={{ fontFamily: monoFont }} numberOfLines={1} selectable>
          {d.id}
        </Text>
      ),
    },
    { key: 'location', title: 'Location', flex: 1, text: (d) => locationName(d.locationId) },
    { key: 'user', title: 'Last signed in', flex: 1.2, text: (d) => userName(d.lastUserId) },
    {
      key: 'seen',
      title: 'Last seen',
      width: 170,
      text: (d) => (d.lastSeenAt ? formatDateTime(d.lastSeenAt) : 'Not yet'),
      sortValue: (d) => d.lastSeenAt ?? '',
    },
    {
      key: 'approved',
      title: 'Status',
      width: 130,
      sortValue: (d) => (d.approved ? 1 : 0),
      render: (d) => <Badge label={d.approved ? 'Approved' : 'Waiting'} tone={d.approved ? 'success' : 'warning'} />,
    },
  ];

  const waiting = (devices ?? []).filter((d) => !d.approved).length;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader
        title="Users & Devices"
        subtitle="Who can sign in, where they work and what they can do, and the PCs and phones SGM runs on."
        actions={
          tab === 'users' ? (
            <Button title="Add user" icon="person-add-outline" onPress={() => setEditingUser('new')} disabled={offline} />
          ) : (
            <>
              <Button title="Refresh" icon="refresh" variant="secondary" onPress={() => void loadDevices()} loading={loadingDevices} />
              <Button title="Add device" icon="add" onPress={() => setEditingDevice('new')} disabled={offline} />
            </>
          )
        }
      />
      {offline ? <Banner tone="warning">{OFFLINE_TEXT}</Banner> : null}
      <SegmentedControl
        accessibilityLabel="Show"
        options={[
          { label: `Users (${users.length})`, value: 'users' },
          { label: devices ? `Devices (${devices.length}${waiting ? `, ${waiting} waiting` : ''})` : 'Devices', value: 'devices' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Card padded>
        <View style={styles.filters}>
          <View style={styles.field}>
            <Select
              label="Location"
              value={locationId}
              options={[{ label: 'All locations', value: ALL }, ...locations.map((l) => ({ label: l.name, value: l.id }))]}
              onChange={setLocationId}
            />
          </View>
          <View style={styles.field}>
            <Select<Role | typeof ALL>
              label={tab === 'users' ? 'Role' : 'Role of who last signed in'}
              value={role}
              options={[{ label: 'All roles', value: ALL }, ...ROLES.map((r) => ({ label: ROLE_LABELS[r], value: r }))]}
              onChange={setRole}
            />
          </View>
        </View>
        {tab === 'users' ? (
          <>
            <DataTable
              rows={shownUsers}
              columns={userColumns}
              rowKey={(u) => u.id}
              minWidth={1000}
              searchPlaceholder="Search users"
              onRowPress={(u) => setEditingUser(u)}
              emptyText="No users match these filters."
            />
            <Text variant="small" muted>
              Click a user to change their role, locations, PIN or permissions, or to disable them. Changes are saved on the SGM server and reach every
              device at its next sync.
            </Text>
          </>
        ) : (
          <>
            {devicesError ? <Banner tone="danger">{devicesError}</Banner> : null}
            <DataTable
              rows={shownDevices}
              columns={deviceColumns}
              rowKey={(d) => d.id}
              minWidth={1000}
              searchPlaceholder="Search devices"
              onRowPress={(d) => setEditingDevice(d)}
              emptyText={devices === null ? 'Loading devices…' : 'No devices match these filters.'}
              initialSort={{ key: 'approved', direction: 'asc' }}
            />
            <Text variant="small" muted>
              A device shows up here after someone tries to sign in on it, and can sign in once approved. To add one ahead of time, copy the Device ID
              from its Settings page. Removing a device signs it out; it can't sign in until it is added again.
            </Text>
          </>
        )}
      </Card>
      <UserDialog
        editing={editingUser}
        me={work.user}
        locations={locations}
        onClose={() => setEditingUser(null)}
      />
      <DeviceDialog
        editing={editingDevice}
        locations={locations}
        thisDevice={deviceId}
        onClose={() => setEditingDevice(null)}
        onSaved={(saved, removed) =>
          setDevices((current) => {
            const others = (current ?? []).filter((d) => d.id !== saved.id);
            return removed ? others : [...others, saved];
          })
        }
      />
    </ScrollView>
  );
}

interface UserForm {
  displayName: string;
  username: string;
  role: Role | '';
  locationIds: string[];
  extraPermissions: Permission[];
  active: boolean;
  pin: string;
}

const blankUser = (): UserForm => ({ displayName: '', username: '', role: 'employee', locationIds: [], extraPermissions: [], active: true, pin: '' });

function UserDialog({
  editing,
  me,
  locations,
  onClose,
}: {
  editing: User | 'new' | null;
  me: User | null;
  locations: Location[];
  onClose: () => void;
}) {
  const { api, session, store } = useServices();
  const toast = useToast();
  const user = editing === 'new' ? null : editing;
  const offline = useOffline();
  const [form, setForm] = useState<UserForm>(blankUser());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    setForm(
      editing === 'new'
        ? blankUser()
        : {
            displayName: editing.displayName,
            username: editing.username,
            role: editing.role,
            locationIds: editing.locationIds,
            extraPermissions: editing.extraPermissions ?? [],
            active: editing.active,
            pin: '',
          },
    );
    setError(null);
  }, [editing]);

  const set = <K extends keyof UserForm>(key: K, value: UserForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const allowed = !user || canManageAccount(me, user.role);
  const roles = ROLES.filter((r) => canManageAccount(me, r));
  const isMe = !!user && user.id === me?.id;
  const rolePermissions = new Set(form.role ? ROLE_PERMISSIONS[form.role] : []);
  // Backups stay with the owner and admins, so they aren't offered here.
  const extras = GRANTABLE_PERMISSIONS.filter((p) => !rolePermissions.has(p));
  const everywhere = form.role === 'owner' || form.role === 'admin';

  const save = async () => {
    setError(null);
    const displayName = form.displayName.trim().replace(/\s+/g, ' ');
    const username = form.username.trim().toLowerCase();
    if (displayName.length < 2) return setError('Enter their name.');
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return setError('Usernames are 3 to 30 letters, numbers, dots, dashes or underscores, like maria.s.');
    if (!form.role) return setError('Choose a role.');
    // The owner and admins are listed at every location, so older copies of the apps let them work anywhere too.
    const locationIds = everywhere ? locations.map((l) => l.id) : form.locationIds;
    if (locationIds.length === 0) return setError('Choose at least one branch or warehouse they work at.');
    if ((!user || form.pin) && !/^\d{4,8}$/.test(form.pin)) return setError(user ? 'A new PIN is 4 to 8 digits. Leave it blank to keep the old one.' : 'Give them a PIN of 4 to 8 digits.');
    if (isMe && (!form.active || form.role !== user?.role)) return setError("You can't disable your own account or change your own role.");
    const token = session.token();
    if (!token) return setError('Sign in again first.');
    setBusy(true);
    try {
      const saved = await api.saveUser(
        {
          id: user?.id,
          username,
          displayName,
          role: form.role,
          locationIds,
          extraPermissions: form.extraPermissions.filter((p) => GRANTABLE_PERMISSIONS.includes(p) && !ROLE_PERMISSIONS[form.role as Role].includes(p)),
          active: form.active,
          ...(form.pin ? { pin: form.pin } : {}),
        },
        token,
      );
      // Shown here straight away; every other device gets it at its next sync.
      await store.batch([put('users', saved)]);
      toast.show(user ? `${saved.displayName} saved.` : `${saved.displayName} can now sign in as ${saved.username}.`, 'success');
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={!!editing}
      title={user ? user.displayName : 'Add user'}
      onClose={onClose}
      dismissable={!busy}
      width={620}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          {allowed ? <Button title={user ? 'Save' : 'Add user'} icon="checkmark" onPress={save} loading={busy} disabled={offline} /> : null}
        </>
      }
    >
      {offline ? <Banner tone="warning">{OFFLINE_TEXT}</Banner> : null}
      {!allowed ? <Banner tone="info">Only the owner can change the owner's and admins' accounts.</Banner> : null}
      <View style={styles.pair}>
        <TextField
          label="Name"
          value={form.displayName}
          onChangeText={(v) => set('displayName', v)}
          containerStyle={styles.half}
          editable={allowed}
          autoFocus={!user}
          autoCapitalize="words"
        />
        <TextField
          label="Username"
          value={form.username}
          onChangeText={(v) => set('username', v)}
          containerStyle={styles.half}
          editable={allowed}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={styles.pair}>
        <View style={styles.half}>
          <Select<Role>
            label="Role"
            value={form.role}
            options={(allowed ? roles : ROLES).map((r) => ({ label: ROLE_LABELS[r], value: r }))}
            onChange={(r) => {
              set('role', r);
              if (r === 'owner' || r === 'admin') set('locationIds', locations.map((l) => l.id));
            }}
            disabled={!allowed || isMe}
          />
        </View>
        <TextField
          label={user ? 'New PIN (optional)' : 'PIN'}
          value={form.pin}
          onChangeText={(v) => set('pin', v.replace(/\D/g, '').slice(0, 8))}
          containerStyle={styles.half}
          keyboardType="number-pad"
          secureTextEntry
          editable={allowed}
          hint={user ? 'Leave blank to keep their PIN. A new PIN also unlocks the account after wrong PINs.' : '4 to 8 digits. Tell them in person.'}
        />
      </View>
      <View style={styles.group}>
        <Text variant="label">Works at</Text>
        {everywhere ? (
          <Text variant="small" muted>
            The owner and admins work at every branch and warehouse.
          </Text>
        ) : form.role === 'manager' ? (
          <Text variant="small" muted>
            A branch manager approves, voids and sees reports only for the branches ticked here.
          </Text>
        ) : null}
        {locations.map((l) => (
          <Checkbox
            key={l.id}
            label={l.name}
            hint={l.kind === 'warehouse' ? 'Warehouse' : 'Branch'}
            checked={everywhere || form.locationIds.includes(l.id)}
            disabled={!allowed || everywhere}
            onChange={(on) => set('locationIds', on ? [...form.locationIds, l.id] : form.locationIds.filter((id) => id !== l.id))}
          />
        ))}
      </View>
      {extras.length > 0 ? (
        <View style={styles.group}>
          <Text variant="label">Also allowed to</Text>
          <Text variant="small" muted>
            {`${form.role ? ROLE_LABELS[form.role] : 'This role'} can already: ${Array.from(rolePermissions, (p) => PERMISSION_LABELS[p].toLowerCase()).join(', ') || 'nothing'}.`}
          </Text>
          {extras.map((p) => (
            <Checkbox
              key={p}
              label={PERMISSION_LABELS[p]}
              checked={form.extraPermissions.includes(p)}
              disabled={!allowed || (p === 'users.manage' && me?.role !== 'owner')}
              onChange={(on) => set('extraPermissions', on ? [...form.extraPermissions, p] : form.extraPermissions.filter((x) => x !== p))}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.group}>
        <Text variant="label">Account</Text>
        <SegmentedControl
          options={[
            { label: 'Active', value: 'yes' },
            { label: 'Disabled', value: 'no' },
          ]}
          value={form.active ? 'yes' : 'no'}
          onChange={(v) => allowed && !isMe && set('active', v === 'yes')}
        />
        <Text variant="small" muted>
          A disabled user can't sign in, and is signed out at their next sync. Their past sales stay in the records.
        </Text>
      </View>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Dialog>
  );
}

function DeviceDialog({
  editing,
  locations,
  thisDevice,
  onClose,
  onSaved,
}: {
  editing: Device | 'new' | null;
  locations: Location[];
  thisDevice: string;
  onClose: () => void;
  onSaved: (device: Device, removed: boolean) => void;
}) {
  const { api, session } = useServices();
  const toast = useToast();
  const device = editing === 'new' ? null : editing;
  const offline = useOffline();
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [locationId, setLocationId] = useState('');
  const [approved, setApproved] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const current = editing === 'new' ? null : editing;
    setId(current?.id ?? '');
    setLabel(current?.label ?? '');
    setLocationId(current?.locationId ?? '');
    setApproved(current?.approved ?? true);
    setError(null);
  }, [editing]);

  const run = async (work: (token: string) => Promise<void>) => {
    const token = session.token();
    if (!token) return setError('Sign in again first.');
    setBusy(true);
    setError(null);
    try {
      await work(token);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const deviceId = id.trim();
    if (!device && !/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) return setError("Paste the Device ID from the device's Settings page.");
    if (label.trim().length < 2) return setError('Give the device a name, like "Main branch counter PC".');
    void run(async (token) => {
      const saved = await api.saveDevice({ id: deviceId, label: label.trim(), locationId: locationId || null, approved }, token);
      onSaved(saved, false);
      toast.show(`${saved.label ?? 'Device'} saved.`, 'success');
      onClose();
    });
  };

  const remove = () =>
    void run(async (token) => {
      await api.removeDevice(device!.id, token);
      onSaved(device!, true);
      setConfirmRemove(false);
      toast.show(`${device!.label ?? 'Device'} removed.`, 'success');
      onClose();
    });

  return (
    <Dialog
      visible={!!editing}
      title={device ? (device.label ?? 'Device') : 'Add device'}
      onClose={onClose}
      dismissable={!busy}
      width={520}
      actions={
        <>
          {device && device.id !== thisDevice ? (
            <Button title="Remove" variant="danger" onPress={() => setConfirmRemove(true)} disabled={busy || offline} />
          ) : null}
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <Button title="Save" icon="checkmark" onPress={save} loading={busy} disabled={offline} />
        </>
      }
    >
      {offline ? <Banner tone="warning">{OFFLINE_TEXT}</Banner> : null}
      {device ? (
        <Text variant="small" muted selectable>
          {`Device ID ${device.id}${device.firstSeenAt ? ` · first seen ${formatDateTime(device.firstSeenAt)}` : ''}`}
        </Text>
      ) : (
        <TextField
          label="Device ID"
          value={id}
          onChangeText={setId}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          hint="Shown on the device's Settings page, under This device."
        />
      )}
      <TextField label="Name" value={label} onChangeText={setLabel} placeholder="e.g. Main branch counter PC" />
      <Select
        label="Location"
        value={locationId}
        options={locations.map((l) => ({ label: l.name, value: l.id, hint: l.kind === 'warehouse' ? 'Warehouse' : 'Branch' }))}
        onChange={setLocationId}
        placeholder="Choose where it is used…"
      />
      <Checkbox
        label="Approved to sign in"
        hint={device?.id === thisDevice ? 'This is the device you are using.' : 'Untick to block it without removing it from the list.'}
        checked={approved}
        disabled={device?.id === thisDevice}
        onChange={setApproved}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <ConfirmDialog
        visible={confirmRemove}
        title="Remove this device?"
        message={`${device?.label ?? 'This device'} will be signed out and can't sign in until it is added again. Sales it hasn't sent yet stay on it until then.`}
        confirmLabel="Remove device"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </Dialog>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  field: { width: 240 },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  half: { flexGrow: 1, flexBasis: 220 },
  group: { gap: spacing.xs },
});

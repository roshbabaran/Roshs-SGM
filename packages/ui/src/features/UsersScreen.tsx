import { permissionsOf, PERMISSION_LABELS, ROLE_LABELS, type Location, type User } from '@sgm/core';
import { ScrollView, StyleSheet } from 'react-native';

import { Badge, Banner, Card, ScreenHeader } from '../Basics';
import { DataTable, type Column } from '../DataTable';
import { useCollection } from '../services';
import { Text } from '../Text';
import { spacing } from '../theme';

export function UsersScreen() {
  const { data: users } = useCollection<User>('users');
  const { data: locations } = useCollection<Location>('locations');
  const locationNames = (ids: string[]) => ids.map((id) => locations.find((l) => l.id === id)?.name ?? id).join(', ');

  const columns: Column<User>[] = [
    { key: 'name', title: 'Name', flex: 1.4, text: (u) => u.displayName },
    { key: 'username', title: 'Username', flex: 1, text: (u) => u.username },
    { key: 'role', title: 'Role', width: 150, text: (u) => ROLE_LABELS[u.role], render: (u) => <Badge label={ROLE_LABELS[u.role]} tone={u.role === 'owner' ? 'info' : 'neutral'} /> },
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
    { key: 'active', title: 'Status', width: 100, render: (u) => <Badge label={u.active ? 'Active' : 'Disabled'} tone={u.active ? 'success' : 'danger'} /> },
  ];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <ScreenHeader title="Users" subtitle="Who can sign in, where they work, and what they can do." />
      <Banner tone="info">
        Accounts are created and changed on the SGM server, which also checks these permissions on every request. This list is the copy this device received at its last sync.
      </Banner>
      <Card padded>
        <DataTable rows={users} columns={columns} rowKey={(u) => u.id} minWidth={1000} searchPlaceholder="Search users" />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: spacing.xl, gap: spacing.lg },
});

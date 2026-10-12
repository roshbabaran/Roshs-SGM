import { PERMISSION_LABELS, type Permission } from '@sgm/core';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { EmptyState } from '../Basics';
import { useWork } from '../services';
import { spacing } from '../theme';

/**
 * Hides a page from people without the permission. This is for a tidy app
 * only; the server must refuse the same actions.
 */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const work = useWork();
  if (work.can(permission)) return <>{children}</>;
  return (
    <View style={styles.root}>
      <EmptyState
        icon="lock-closed-outline"
        title="You don't have access to this page"
        message={`It needs permission to ${PERMISSION_LABELS[permission].toLowerCase()}. Ask the owner if you need it.`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
});

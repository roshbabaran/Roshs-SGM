import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';
import { radius, spacing, useTheme } from './theme';

export interface DialogProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons along the bottom. */
  actions?: ReactNode;
  width?: number;
  /** Set false for dialogs that must not close by clicking outside (e.g. while saving). */
  dismissable?: boolean;
}

/** Escape (desktop) and the back button (Android) close it through onRequestClose. */
export function Dialog({ visible, title, onClose, children, actions, width = 520, dismissable = true }: DialogProps) {
  const { colors } = useTheme();
  const close = dismissable ? onClose : () => {};
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.root, { backgroundColor: colors.overlay }]}
      >
        {/* Clicking outside closes it. A plain View, so keyboard focus starts inside the dialog instead. */}
        <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => true} onResponderRelease={close} />
        <View
          style={[styles.card, { maxWidth: width, backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityRole="alert"
        >
          <View style={styles.header}>
            <Text variant="subheading" style={styles.title}>
              {title}
            </Text>
            {dismissable ? (
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
                <Icon name="close" size={20} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {actions ? <View style={[styles.actions, { borderTopColor: colors.border }]}>{actions}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      visible={visible}
      title={title}
      onClose={onCancel}
      width={420}
      dismissable={!busy}
      actions={
        <>
          <Button title="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
          <Button title={confirmLabel} variant={danger ? 'danger' : 'primary'} onPress={onConfirm} loading={busy} />
        </>
      }
    >
      <Text>{message}</Text>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: {
    width: '100%',
    maxHeight: '92%',
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: { flex: 1 },
  close: { padding: spacing.xs, cursor: 'pointer' },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, gap: spacing.md },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
  },
});

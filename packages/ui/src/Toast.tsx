import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { radius, spacing, toneColors, useTheme } from './theme';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

const ICONS: Record<ToastKind, IconName> = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  info: 'information-circle',
};

/** Short messages in the corner, e.g. "Sale saved". Errors stay up longer. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setItems((current) => [...current, { id, message, kind }].slice(-3));
    setTimeout(() => setItems((current) => current.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View style={[styles.stack, Platform.OS === 'web' ? styles.stackDesktop : styles.stackPhone]}>
        {items.map((item) => {
          const tone = toneColors(colors, item.kind === 'error' ? 'danger' : item.kind === 'success' ? 'success' : 'info');
          return (
            <View
              key={item.id}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[styles.toast, { backgroundColor: colors.surface, borderColor: tone.fg }]}
            >
              <Icon name={ICONS[item.kind]} color={tone.fg} size={20} />
              <Text style={styles.message}>{item.message}</Text>
            </View>
          );
        })}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const styles = StyleSheet.create({
  stack: { position: 'absolute', gap: spacing.sm, pointerEvents: 'box-none' },
  stackDesktop: { right: spacing.xl, bottom: spacing.xl, width: 360 },
  stackPhone: { left: spacing.lg, right: spacing.lg, bottom: 90 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: spacing.md,
    pointerEvents: 'auto',
  },
  message: { flex: 1 },
});

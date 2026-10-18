import { FitTablesToScreen, useTheme } from '@sgm/ui';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Keeps a page clear of the status bar and notch, and fits its tables to the
 * screen. The tab bar takes care of the bottom edge.
 */
export function Screen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, { backgroundColor: colors.background }]}>
      <FitTablesToScreen>{children}</FitTablesToScreen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

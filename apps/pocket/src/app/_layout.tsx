import { ServicesBoundary, ThemeProvider, ToastProvider, useTheme } from '@sgm/ui';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationTheme, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { createPocketServices } from '@/services/create-services';

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ServicesBoundary create={createPocketServices}>
          <Navigation />
        </ServicesBoundary>
      </ToastProvider>
    </ThemeProvider>
  );
}

/** Gives the navigation (screen backgrounds, tab bar) the same colours as SGM's screens. */
function Navigation() {
  const { dark, colors } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: colors.primary, background: colors.background, card: colors.surface, text: colors.text, border: colors.border },
  };
  return (
    <NavigationTheme value={theme}>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style={dark ? 'light' : 'dark'} />
    </NavigationTheme>
  );
}

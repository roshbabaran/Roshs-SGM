import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';

/** SGM colours. Change them here and both apps follow. */
const light = {
  background: '#F4F5F7',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF0F3',
  border: '#D9DDE3',
  text: '#15181D',
  textMuted: '#5C6570',
  primary: '#1747C6',
  primaryPressed: '#123A9F',
  primaryText: '#FFFFFF',
  primarySoft: '#E5ECFB',
  accent: '#E8731A',
  success: '#137A43',
  successSoft: '#E2F3E9',
  warning: '#8F5600',
  warningSoft: '#FFF1D6',
  danger: '#BF2A2A',
  dangerSoft: '#FBE5E5',
  overlay: 'rgba(10, 14, 20, 0.45)',
  sidebar: '#0F1B33',
  sidebarText: '#C5CFE3',
  sidebarActive: '#213A68',
  sidebarActiveText: '#FFFFFF',
};

export type ThemeColors = typeof light;

const dark: ThemeColors = {
  background: '#0E1116',
  surface: '#171B22',
  surfaceMuted: '#1F242D',
  border: '#2E3540',
  text: '#ECEFF3',
  textMuted: '#9AA4B2',
  primary: '#5B8CFF',
  primaryPressed: '#4777EA',
  primaryText: '#0B1020',
  primarySoft: '#1C2A4A',
  accent: '#F28C3A',
  success: '#4CC38A',
  successSoft: '#163126',
  warning: '#F2B544',
  warningSoft: '#3A2C10',
  danger: '#F07272',
  dangerSoft: '#3B1A1A',
  overlay: 'rgba(0, 0, 0, 0.6)',
  sidebar: '#0A101C',
  sidebarText: '#AEB9CE',
  sidebarActive: '#1C2E52',
  sidebarActiveText: '#FFFFFF',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
export const fontSize = { xs: 12, sm: 13, md: 15, lg: 18, xl: 22, xxl: 28 } as const;

export const monoFont = Platform.select({
  web: 'Consolas, "Courier New", monospace',
  ios: 'Menlo',
  default: 'monospace',
});

export interface Theme {
  dark: boolean;
  colors: ThemeColors;
}

const ThemeContext = createContext<Theme>({ dark: false, colors: light });

/** Follows the device's light/dark setting unless `scheme` forces one. */
export function ThemeProvider({ scheme, children }: { scheme?: 'light' | 'dark'; children: ReactNode }) {
  const system = useColorScheme();
  const isDark = (scheme ?? system) === 'dark';
  const theme = useMemo(() => ({ dark: isDark, colors: isDark ? dark : light }), [isDark]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function toneColors(colors: ThemeColors, tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'info':
      return { fg: colors.primary, bg: colors.primarySoft };
    case 'success':
      return { fg: colors.success, bg: colors.successSoft };
    case 'warning':
      return { fg: colors.warning, bg: colors.warningSoft };
    case 'danger':
      return { fg: colors.danger, bg: colors.dangerSoft };
    default:
      return { fg: colors.textMuted, bg: colors.surfaceMuted };
  }
}

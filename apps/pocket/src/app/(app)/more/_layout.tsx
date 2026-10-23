import { useTheme } from '@sgm/ui';
import { Stack } from 'expo-router';

// A page that fails shows what went wrong, with Try again and Sign out, instead of closing the app.
export { ScreenError as ErrorBoundary } from '@sgm/ui';

// A page opened straight from elsewhere (Inventory from the dashboard) still has the menu to go back to.
export const unstable_settings = { initialRouteName: 'index' };

/** The More tab: a menu, and the pages it opens with a back button above them. */
export default function MoreLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        title: '',
        headerBackTitle: 'More',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.primary,
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}

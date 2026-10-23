import { SettingsScreen } from '@sgm/ui';

// A page that fails shows what went wrong, with Try again and Sign out, instead of closing the app.
export { ScreenError as ErrorBoundary } from '@sgm/ui';

export default function SettingsPage() {
  return <SettingsScreen />;
}

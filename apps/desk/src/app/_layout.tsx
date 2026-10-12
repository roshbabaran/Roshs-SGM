import { ServicesBoundary, ThemeProvider, ToastProvider } from '@sgm/ui';
import { Slot } from 'expo-router';

import { createDeskServices } from '@/services/create-services';

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ServicesBoundary create={createDeskServices}>
          <Slot />
        </ServicesBoundary>
      </ToastProvider>
    </ThemeProvider>
  );
}

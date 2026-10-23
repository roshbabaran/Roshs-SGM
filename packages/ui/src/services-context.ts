import { createContext, useContext } from 'react';

import type { AppServices } from './services';

/**
 * The app's services, apart from services.tsx so that AppGate (which services.tsx
 * shows) can read them without the two files importing each other.
 */
export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesBoundary>.');
  return services;
}

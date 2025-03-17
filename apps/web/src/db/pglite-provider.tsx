/**
 * Minimal PGlite Provider
 * 
 * This component provides the PGlite context to components that need it,
 * but doesn't handle initialization or error handling.
 */

import { ReactNode } from 'react';
import { PGliteProvider } from '@electric-sql/pglite-react';
import { db } from './core';
import { assertDatabaseWithLive } from './core';
import type { AnyPGliteWithLive } from './types';

interface MinimalPGliteProviderProps {
  children: ReactNode;
}

export function MinimalPGliteProvider({ children }: MinimalPGliteProviderProps) {
  // If db is not initialized, just render children without the provider
  if (!db) {
    console.warn('PGlite database not initialized, rendering without provider');
    return <>{children}</>;
  }
  
  // Assert db has live namespace before providing it
  const dbWithLive = assertDatabaseWithLive(db);
  
  return (
    <PGliteProvider db={dbWithLive}>
      {children}
    </PGliteProvider>
  );
} 
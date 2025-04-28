/**
 * PGlite React Provider
 * 
 * This file provides a React context provider for the PGlite database.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { initializeDatabase, getDatabase, dbMessageBus } from './db.ts';

// Create context
interface PGliteContextValue {
  isLoading: boolean;
  isReady: boolean;
  error: Error | null;
}

const PGliteContext = createContext<PGliteContextValue>({
  isLoading: true,
  isReady: false,
  error: null
});

// Hook to access PGlite context
export function usePGliteContext() {
  return useContext(PGliteContext);
}

interface PGliteProviderProps {
  children: React.ReactNode;
}

/**
 * Vibestack PGlite Provider Component
 * 
 * This provider initializes the PGlite database and provides context
 * about its status to the application.
 */
export function VibestackPGliteProvider({ children }: PGliteProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;
    
    // Set up event listeners
    const unsubInitialized = dbMessageBus.subscribe('initialized', () => {
      if (isMounted) {
        setIsReady(true);
        setIsLoading(false);
      }
    });
    
    const unsubError = dbMessageBus.subscribe('error', (data) => {
      if (isMounted) {
        setError(data.error || new Error('Unknown database error'));
        setIsLoading(false);
      }
    });
    
    // Initialize the database
    async function init() {
      try {
        console.log('PGlite Provider initializing database...');
        await initializeDatabase();
        
        if (isMounted) {
          setIsReady(true);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Error initializing database in provider:', err);
        
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    }
    
    // Check if database is already initialized
    getDatabase()
      .then(() => {
        if (isMounted) {
          setIsReady(true);
          setIsLoading(false);
        }
      })
      .catch(() => {
        // If not already initialized, start initialization
        init();
      });
    
    return () => {
      isMounted = false;
      unsubInitialized();
      unsubError();
    };
  }, []);

  // Provide context to children
  return (
    <PGliteContext.Provider value={{ isLoading, isReady, error }}>
      {children}
    </PGliteContext.Provider>
  );
}

/**
 * Minimal PGlite Provider for testing and specific use cases
 */
export function MinimalPGliteProvider({ children }: PGliteProviderProps) {
  return <>{children}</>;
} 
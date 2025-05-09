/**
 * PGlite React Provider
 * 
 * This file provides a React context provider for the PGlite database.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { initializeDatabase, getDatabase, dbMessageBus } from './db.ts';
import { getNewPGliteDataSource } from './newtypeorm/NewDataSource';
import { createRepositories } from './repositories';
import { createServices } from './services';
import { SyncManager } from '../sync/SyncManager';

// Create context with repositories and services
interface PGliteContextValue {
  isLoading: boolean;
  isReady: boolean;
  error: Error | null;
  repositories?: any;
  services?: any;
}

const PGliteContext = createContext<PGliteContextValue>({
  isLoading: true,
  isReady: false,
  error: null,
  repositories: null,
  services: null
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
 * This provider initializes both legacy PGlite and TypeORM and provides context
 * about its status to the application.
 */
export function VibestackPGliteProvider({ children }: PGliteProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [repositories, setRepositories] = useState<any>(null);
  const [services, setServices] = useState<any>(null);
  const [typeormInitialized, setTypeormInitialized] = useState(false);

  useEffect(() => {
    let isMounted = true;
    
    // Set up event listeners
    const unsubInitialized = dbMessageBus.subscribe('initialized', () => {
      if (isMounted) {
        setIsReady(true);
        setIsLoading(false);
        
        // Initialize TypeORM after PGlite is ready
        if (!typeormInitialized) {
          initializeTypeorm().catch(err => {
            console.error('Error initializing TypeORM:', err);
          });
        }
      }
    });
    
    const unsubError = dbMessageBus.subscribe('error', (data) => {
      if (isMounted) {
        setError(data.error || new Error('Unknown database error'));
        setIsLoading(false);
      }
    });
    
    // Initialize the database (legacy PGlite)
    async function init() {
      try {
        console.log('PGlite Provider initializing database...');
        await initializeDatabase();
        
        if (isMounted) {
          setIsReady(true);
          setIsLoading(false);
          
          // Initialize TypeORM after PGlite is ready
          if (!typeormInitialized) {
            await initializeTypeorm();
          }
        }
      } catch (err) {
        console.error('Error initializing database in provider:', err);
        
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    }
    
    // Initialize TypeORM repositories and services
    async function initializeTypeorm() {
      try {
        console.log('Initializing TypeORM repositories and services...');
        
        // Get DataSource
        const dataSource = await getNewPGliteDataSource();
        
        // Create repositories
        const repos = await createRepositories();
        
        // Get SyncChangeManager
        const syncManager = SyncManager.getInstance();
        // Ensure SyncManager's own initialization is complete before accessing OutgoingChangeProcessor
        await syncManager.initialize();
        const outgoingChangeProcessor = syncManager.getOutgoingChangeProcessor();
        
        // Create services
        const svcs = createServices(repos, outgoingChangeProcessor);
        
        if (isMounted) {
          setRepositories(repos);
          setServices(svcs);
          setTypeormInitialized(true);
          console.log('TypeORM repositories and services initialized');
        }
      } catch (err) {
        console.error('Error initializing TypeORM in provider:', err);
      }
    }
    
    // Check if database is already initialized
    getDatabase()
      .then(() => {
        if (isMounted) {
          setIsReady(true);
          setIsLoading(false);
          
          // Initialize TypeORM after PGlite is ready
          if (!typeormInitialized) {
            initializeTypeorm().catch(err => {
              console.error('Error initializing TypeORM:', err);
            });
          }
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

  // Provide context to children with repositories and services
  return (
    <PGliteContext.Provider value={{ 
      isLoading, 
      isReady, 
      error,
      repositories,
      services 
    }}>
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
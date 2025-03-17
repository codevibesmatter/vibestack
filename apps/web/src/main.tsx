import 'reflect-metadata'
import React, { Suspense, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { LoadingScreen } from './components/LoadingScreen'
import './index.css'
import { initializeDatabase, terminateDatabase } from './db/core'
import { initSync, cleanupSyncService } from './sync/service'
import { dbMessageBus } from './db/message-bus'
import { checkAndApplyMigrations } from './db/migration-manager'

// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// App component with database and sync initialization
function App() {
  const [isDbInitialized, setIsDbInitialized] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  
  // Initialize database and sync when the app starts
  useEffect(() => {
    let mounted = true;
    
    const initialize = async () => {
      try {
        console.log('Initializing database...');
        
        // Initialize database
        const dbInstance = await initializeDatabase();
        
        if (!mounted) return;
        
        if (dbInstance) {
          console.log('Database initialized successfully');
          
          // Check and apply migrations before initializing sync service
          console.log('Checking for database migrations...');
          const migrationsApplied = await checkAndApplyMigrations(dbInstance);
          
          if (migrationsApplied) {
            console.log('Database migrations check completed successfully');
          } else {
            console.warn('Database migrations check completed with warnings');
            // Continue anyway to support offline mode
          }
          
          setIsDbInitialized(true);
          
          // Initialize sync service
          console.log('Initializing sync service...');
          const syncInitialized = initSync();
          
          if (syncInitialized) {
            console.log('Sync service initialized successfully');
          } else {
            console.error('Failed to initialize sync service');
          }
        } else {
          setDbError('Failed to initialize database');
        }
      } catch (error) {
        if (!mounted) return;
        console.error('Error initializing:', error);
        setDbError(error instanceof Error ? error.message : 'Unknown error');
      }
    };
    
    initialize();
    
    // Subscribe to database events
    const unsubscribeInit = dbMessageBus.subscribe('initialized', () => {
      setIsDbInitialized(true);
      setDbError(null);
    });
    
    const unsubscribeError = dbMessageBus.subscribe('error', (data) => {
      setDbError(data.error);
    });
    
    // Clean up resources when the app unmounts
    return () => {
      mounted = false;
      unsubscribeInit();
      unsubscribeError();
      
      // Skip cleanup during HMR to prevent unnecessary service restarts
      if (!import.meta.hot) {
        cleanupSyncService();
        terminateDatabase();
      }
    };
  }, []);
  
  // Show loading screen while database is initializing
  if (!isDbInitialized) {
    return <LoadingScreen message={dbError ? `Error: ${dbError}` : 'Initializing database...'} />;
  }
  
  return <RouterProvider router={router} />;
}

// Create root element
const rootElement = document.getElementById('root')!

// For HMR in development, we need to handle the root differently
if (import.meta.env.DEV) {
  // In development, unmount any existing React tree before creating a new root
  // This prevents the "container has already been passed to createRoot()" warning
  let root = ReactDOM.createRoot(rootElement)
  root.render(
    // Removed StrictMode for more accurate performance measurements
    <Suspense fallback={<LoadingScreen />}>
      <App />
    </Suspense>
  )

  // Handle HMR
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      root.unmount()
    })
  }
} else {
  // In production, just create the root once
  ReactDOM.createRoot(rootElement).render(
    // Removed StrictMode for more accurate performance measurements
    <Suspense fallback={<LoadingScreen />}>
      <App />
    </Suspense>
  )
}

/**
 * PGlite Database Implementation
 * 
 * This file provides the main database functionality for the application,
 * including database initialization, connection management, and core operations.
 */

import { PGlite } from '@electric-sql/pglite';
// Import PGliteWorker from the worker submodule again
// @ts-ignore - Ignore potential type definition issue
import { PGliteWorker } from '@electric-sql/pglite/worker';
// Import the worker script using Vite's ?worker syntax
import VibestackWorker from './worker.ts?worker';
import { resetEntireDatabase } from './storage';
// Import the live extension to pass to the worker constructor
import { live } from '@electric-sql/pglite/live';
// Remove unused/incorrect import
// import { VibestackWorker as VibestackWorkerImport } from './worker';
// Remove import for non-existent file
// import { validateDatabaseSchema } from './schema-validator';
import { checkAndApplyMigrations } from './migration-manager';

// Properly type PGlite results
// Based on PGlite's typical result structure
export interface Results<T = any> {
  rows: T[];
  // Include other potential properties if known, e.g., command, rowCount
  command?: string;
  rowCount?: number;
  // Add other fields as needed based on PGlite documentation or usage
}

// Export types (PGliteWithLive might need re-evaluation if direct access is removed)
// For now, we'll keep it, but interaction will primarily be via PGliteWorker
export interface PGliteWithLive extends PGlite {
  live: {
    query: (sql: string, params?: any[]) => Promise<{ 
      results: any[]; 
      unsubscribe: () => void 
    }>;
  };
}

// Event bus for database events
type EventCallback = (data: any) => void;
type EventsMap = Record<string, Set<EventCallback>>;

// Simple event bus for database events
export class DbMessageBus {
  private events: EventsMap = {};

  subscribe(event: string, callback: EventCallback): () => void {
    if (!this.events[event]) {
      this.events[event] = new Set();
    }
    this.events[event].add(callback);
    
    return () => this.unsubscribe(event, callback);
  }

  unsubscribe(event: string, callback: EventCallback): void {
    if (this.events[event]) {
      this.events[event].delete(callback);
    }
  }

  publish(event: string, data: any = {}): void {
    if (this.events[event]) {
      this.events[event].forEach(callback => callback(data));
    }
  }
}

// Create and export a single instance of the message bus
export const dbMessageBus = new DbMessageBus();

// Global database instances
let pgliteWorkerInstance: PGliteWorker | null = null;
let workerInstance: Worker | null = null; // Store the raw worker too
let isInitializing = false;
let initPromise: Promise<PGliteWorker> | null = null;

// HMR Persistence
// Store instances during HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(async (data) => {
    console.log("🔥 HMR Dispose: Storing DB worker instances");
    // We might not need to explicitly terminate if we're reusing,
    // but ensure clean state if needed. Consider if termination is better.
    // For now, just store the references.
    data.pgliteWorkerInstance = pgliteWorkerInstance;
    data.workerInstance = workerInstance;
    // Reset module state for next load if instances aren't reused
    // pgliteWorkerInstance = null; 
    // workerInstance = null;
    // isInitializing = false;
    // initPromise = null;
  });
}

/**
 * Get the database instance (PGliteWorker), creating it if necessary
 */
export async function getDatabase(): Promise<PGliteWorker> {
  if (pgliteWorkerInstance) {
    return pgliteWorkerInstance;
  }
  
  // If initialization is in progress, wait for it
  if (isInitializing && initPromise) {
    return initPromise;
  }

  // Start initialization if not already started
  return initializeDatabase();
}

/**
 * Short alias for the database instance (might be less useful now)
 */
export const db = pgliteWorkerInstance;

/**
 * Initialize the database using PGliteWorker
 */
export async function initializeDatabase(): Promise<PGliteWorker> {
  // HMR Restore: Check if instances were preserved
  if (import.meta.hot?.data.pgliteWorkerInstance) {
    console.log("🔥 HMR Restore: Reusing existing DB worker instances");
    pgliteWorkerInstance = import.meta.hot.data.pgliteWorkerInstance;
    workerInstance = import.meta.hot.data.workerInstance;
    isInitializing = false; // Ensure state is reset
    initPromise = null;     // Ensure state is reset
    // Optional: Verify connection is still alive (e.g., ping)
    // try { await pgliteWorkerInstance.query('SELECT 1'); } catch { ... reinit? }
    return pgliteWorkerInstance;
  }

  if (pgliteWorkerInstance) {
    return pgliteWorkerInstance;
  }
  
  if (isInitializing) {
    console.log('PGliteWorker already initializing, waiting for completion');
    return initPromise!;
  }
  
  isInitializing = true;
  
  console.log('🔄 Initializing PGliteWorker...');
  
  initPromise = (async () => {
    try {
      // Create the worker instance using Vite's import
      const worker = new VibestackWorker();
      
      // Instantiate PGliteWorker, connecting it to the actual worker
      // Cast to any to bypass incorrect type definition
      const PGliteWorkerConstructor = PGliteWorker as any;
      const pgliteWorker = new PGliteWorkerConstructor(
        worker,
        { // Pass options to expose live extension
          extensions: {
            live,
          },
        }
      );
      
      // Optional: Add listener for debugging worker messages
      worker.addEventListener('message', (event: MessageEvent) => {
        // Avoid logging internal PGliteWorker protocol messages if too noisy
        if (!event.data?.type?.startsWith('pglite:')) {
           console.debug('PGlite worker message:', event.data);
        }
      });

      // Wait for the worker to signal readiness and verify live queries
      await pgliteWorker.query('SELECT 1');
      
      // Verify live query support
      if (!pgliteWorker.live?.query) {
        console.warn('Live queries not available despite configuration');
      } else {
        console.log('Live queries enabled successfully');
      }

      // Store both instances
      pgliteWorkerInstance = pgliteWorker;
      workerInstance = worker;
      
      // Remove database reset code that was only for debugging
      // await resetEntireDatabase();
      
      // ** Remove call to validateDatabaseSchema **
      // await validateDatabaseSchema(pgliteWorkerInstance);
      
      // Check and apply migrations
      await checkAndApplyMigrations();
      
      console.log('✅ PGliteWorker initialized successfully');
      dbMessageBus.publish('initialized', { success: true });
      
      return pgliteWorkerInstance;
    } catch (error) {
      console.error('❌ Error initializing PGliteWorker:', error);
      dbMessageBus.publish('error', { error });
      throw error;
    } finally {
      isInitializing = false;
    }
  })();
  
  return initPromise;
}

/**
 * Clear database storage (needs adaptation for worker)
 */
export async function clearDatabaseStorage(): Promise<boolean> {
  try {
    console.log('🗑️ Clearing PGlite database storage...');
    
    // Terminate current worker connection first
    if (pgliteWorkerInstance) {
      await terminateDatabase();
    }
    
    // Clearing IndexedDB remains the same as it's a browser API
    await clearIndexedDBStorage();
    
    console.log('✅ PGlite database storage cleared');
    return true;
  } catch (error) {
    console.error('❌ Error clearing PGlite database storage:', error);
    return false;
  }
}

/**
 * Helper to clear IndexedDB storage
 */
async function clearIndexedDBStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      // Use the correct DB name defined in worker.ts
      const DB_NAME = 'vibestack-admin-db'; 
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => {
        console.log(`Successfully deleted ${DB_NAME} database from IndexedDB`);
        resolve();
      };
      req.onerror = (event) => {
        console.error(`Error deleting ${DB_NAME} database:`, event);
        reject(new Error(`Failed to delete ${DB_NAME} database`));
      };
      req.onblocked = () => {
        console.warn(`Deletion of ${DB_NAME} database is blocked. Close other tabs/connections.`);
        // Potentially reject or wait, depending on desired behavior
        reject(new Error(`Deletion of ${DB_NAME} database is blocked`));
      }
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Terminate the database connection (now terminates the worker)
 */
export async function terminateDatabase(): Promise<void> {
  if (workerInstance) { // Check raw worker instance
    try {
      console.log('🛑 Terminating PGliteWorker connection...');
      workerInstance.terminate(); // Terminate the raw worker
      pgliteWorkerInstance = null;
      workerInstance = null; // Clear raw worker instance
      initPromise = null;
      isInitializing = false; // Reset initialization state
    } catch (error) {
      console.error('❌ Error terminating PGliteWorker:', error);
    }
  }
}

/**
 * Validate and create database schema if needed (adapted for PGliteWorker)
 * --- KEEP THIS FUNCTION DEFINITION EVEN IF UNUSED FOR NOW --- 
 */
export async function validateDatabaseSchema(dbWorker: PGliteWorker): Promise<void> {
  try {
    // Check if the schema version table exists using the worker
    const schemaVersionExists = await checkTableExists(dbWorker, 'schema_version');
    
    if (!schemaVersionExists) {
      console.log('Creating initial database schema via worker...');
      await createInitialSchema(dbWorker);
    } else {
      console.log('Database schema already exists (checked via worker)');
    }
  } catch (error) {
    console.error('Error validating database schema via worker:', error);
    throw error;
  }
}

/**
 * Check if a table exists in the database (adapted for PGliteWorker)
 */
async function checkTableExists(dbWorker: PGliteWorker, tableName: string): Promise<boolean> {
  try {
    // Use the worker's query method
    // Use PostgreSQL's information_schema instead of sqlite_master
    const result = await dbWorker.query<any[]>(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = $1
    `, [tableName]);
    
    return result.length > 0;
  } catch (error) {
    console.error('Error checking table existence:', error);
    return false;
  }
}

// --- KEEP createInitialSchema --- 
async function createInitialSchema(dbWorker: PGliteWorker): Promise<void> {
  // Implementation of createInitialSchema function
}

// ... (rest of file: getDatabaseStatus, assertDatabaseIsWorker, types, and final initializeDatabase() call) ...

// REMOVED: Module-level initialization call
// initializeDatabase().catch(error => {
//   console.error('Failed to initialize database at startup:', error);
// }); 
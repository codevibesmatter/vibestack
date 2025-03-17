/**
 * LSN Manager
 * 
 * This module provides a centralized way to manage the Log Sequence Number (LSN)
 * and client ID using IndexedDB, which can be accessed by both the main thread 
 * and worker thread.
 */

// Database configuration
const DB_NAME = 'vibestack_sync';
const DB_VERSION = 2; // Increased version for new schema
const SYNC_STORE = 'sync_data';
const LSN_KEY = 'current_lsn';
const CLIENT_ID_KEY = 'client_id';

/**
 * LSN Manager class
 */
export class LSNManager {
  private db: IDBDatabase | null = null;
  private isInitialized = false;
  private initPromise: Promise<boolean> | null = null;
  private cachedLSN: string | null = null;
  private cachedClientId: string | null = null;
  
  /**
   * Initialize the database
   */
  public initialize(): Promise<boolean> {
    // If already initialized or initializing, return the existing promise
    if (this.isInitialized) {
      return Promise.resolve(true);
    }
    
    if (this.initPromise) {
      return this.initPromise;
    }
    
    // Create a new initialization promise
    this.initPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          
          // Handle version upgrade
          if (event.oldVersion < 1) {
            // Create the sync store if it doesn't exist
            if (!db.objectStoreNames.contains(SYNC_STORE)) {
              db.createObjectStore(SYNC_STORE);
            }
          }
          if (event.oldVersion < 2) {
            // Migrate data from old store if it exists
            if (db.objectStoreNames.contains('lsn')) {
              const transaction = (event.target as IDBOpenDBRequest).transaction;
              if (transaction) {
                const oldStore = transaction.objectStore('lsn');
                const newStore = db.objectStoreNames.contains(SYNC_STORE) 
                  ? transaction.objectStore(SYNC_STORE)
                  : db.createObjectStore(SYNC_STORE);
                
                oldStore.get(LSN_KEY).onsuccess = (e) => {
                  const lsn = (e.target as IDBRequest).result;
                  if (lsn) {
                    newStore.put(lsn, LSN_KEY);
                  }
                };
                
                db.deleteObjectStore('lsn');
              }
            }
          }
        };
        
        request.onsuccess = (event) => {
          this.db = (event.target as IDBOpenDBRequest).result;
          this.isInitialized = true;
          resolve(true);
        };
        
        request.onerror = () => {
          reject(new Error('Failed to initialize IndexedDB'));
        };
      } catch (error) {
        reject(error);
      }
    });
    
    return this.initPromise;
  }
  
  /**
   * Get the current LSN
   */
  public async getLSN(): Promise<string> {
    if (this.cachedLSN !== null) {
      return this.cachedLSN;
    }
    
    const value = await this.getValue(LSN_KEY);
    this.cachedLSN = value || '0/0';
    return this.cachedLSN;
  }
  
  /**
   * Set the current LSN
   */
  public async setLSN(lsn: string): Promise<boolean> {
    const success = await this.setValue(LSN_KEY, lsn);
    if (success) {
      this.cachedLSN = lsn;
    }
    return success;
  }

  /**
   * Get the client ID
   */
  public async getClientId(): Promise<string | null> {
    if (this.cachedClientId !== null) {
      return this.cachedClientId;
    }
    
    const value = await this.getValue(CLIENT_ID_KEY);
    this.cachedClientId = value;
    return this.cachedClientId;
  }
  
  /**
   * Set the client ID
   */
  public async setClientId(clientId: string): Promise<boolean> {
    const success = await this.setValue(CLIENT_ID_KEY, clientId);
    if (success) {
      this.cachedClientId = clientId;
    }
    return success;
  }
  
  /**
   * Get a value from the store
   */
  private getValue(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      try {
        const transaction = this.db.transaction([SYNC_STORE], 'readonly');
        const store = transaction.objectStore(SYNC_STORE);
        const request = store.get(key);
        
        request.onsuccess = () => {
          resolve(request.result || null);
        };
        
        request.onerror = () => {
          reject(new Error(`Failed to get value for key: ${key}`));
        };
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Set a value in the store
   */
  private setValue(key: string, value: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      
      try {
        const transaction = this.db.transaction([SYNC_STORE], 'readwrite');
        const store = transaction.objectStore(SYNC_STORE);
        const request = store.put(value, key);
        
        request.onsuccess = () => {
          resolve(true);
        };
        
        request.onerror = () => {
          reject(new Error(`Failed to set value for key: ${key}`));
        };
      } catch (error) {
        reject(error);
      }
    });
  }
}

// Create a singleton instance
let instance: LSNManager | null = null;

/**
 * Get the LSN manager instance
 */
export function getLSNManager(): LSNManager {
  if (!instance) {
    instance = new LSNManager();
  }
  return instance;
} 
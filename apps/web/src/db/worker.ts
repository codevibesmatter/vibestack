/**
 * PGlite Worker Implementation
 * 
 * This file provides the worker implementation for PGlite.
 */

import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { live } from '@electric-sql/pglite/live';
import { IdbFs } from '@electric-sql/pglite';

// Database name for storage
// IMPORTANT: Must be kept in sync with DB_NAME in db.ts
const DB_NAME = 'vibestack-db';

// Configure the database with IndexedDB filesystem
// We're using IndexedDB for persistence across sessions
const config = {
  fs: new IdbFs(DB_NAME),
  extensions: { 
    uuid_ossp,
    // Register the live extension
    live
  },
  // Disable relaxed durability to ensure writes are flushed to IndexedDB synchronously
  // This guarantees persistence across sessions/refreshes for critical updates like processedSync
  relaxedDurability: true,
  // Set a larger cache size to reduce disk I/O
  cacheSize: 5000
};

// Worker initialization
worker({
  async init() {
    console.log('🔄 Initializing PGlite worker with IndexedDB storage...');
    
    try {
      // Create/open database with configuration
      console.log('🔄 Creating/opening database...');
      const db = await PGlite.create(config);
      
      // Create the uuid-ossp extension if needed
      console.log('🔄 Creating uuid-ossp extension...')
      await db.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
      
      // Initialize live extension
      console.log('🔄 Initializing live extension...');
      if (db.live) {
        console.log('✅ Live extension initialized successfully');
      } else {
        console.warn('⚠️ Live extension not available');
      }
      
      console.log('✅ Database initialized successfully');
      return db;
    } catch (err) {
      console.error('❌ Failed to initialize database:', err);
      throw err;
    }
  },
}); 
import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { live } from '@electric-sql/pglite/live';
import { IdbFs } from '@electric-sql/pglite';

// Database name for storage
const DB_NAME = 'vibestack-db';

// Configure the database with IndexedDB filesystem
// We're using IndexedDB for persistence across sessions
const config = {
  fs: new IdbFs(DB_NAME),
  extensions: { 
    uuid_ossp,
    // The live extension is registered but not enabled via SQL
    // It will be set up in the main thread
    live 
  },
  // Use relaxed durability for better performance
  // This returns query results immediately and flushes to IndexedDB asynchronously
  relaxedDurability: true,
  // Set a larger cache size to reduce disk I/O
  cacheSize: 5000
};

// Initialize the worker
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
      
      console.log('✅ Database initialized successfully');
      return db;
    } catch (err) {
      console.error('❌ Failed to initialize database:', err);
      throw err;
    }
  },
}); 
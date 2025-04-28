// Patches were applied via bundler alias, no longer needed here.
// import { applyNeonPatches } from './neon-orm/NeonPatches';
// applyNeonPatches();

// Now import other modules
import 'reflect-metadata'; // Required by TypeORM
import { DataSourceOptions } from 'typeorm';
import { NeonDataSource, NeonDataSourceOptions, createNeonDataSource } from './neon-orm/NeonDataSource';
import { NeonDriverOptions } from './neon-orm/NeonDriver'; // Keep NeonDriverOptions if used explicitly, though likely redundant now
import * as ServerEntities from '@repo/dataforge/server-entities'; // Import all entities
import type { Context } from 'hono'; // Import Hono context
import type { Env } from '../types/env'; // Import Env type
import { addConnectTimeout } from './db'; // Import helper from db.ts

// Change the singleton instance type
let appDataSource: NeonDataSource | null = null;
let initPromise: Promise<NeonDataSource> | null = null; // Promise to track ongoing initialization

/**
 * Initializes and returns the singleton NeonDataSource instance using context.
 */
export const getDataSource = async (c: Context<{ Bindings: Env }>): Promise<NeonDataSource> => {
    const requestId = c.req.header('cf-request-id') || `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    console.log(`[${requestId}] getDataSource: Called.`);

    // Return existing instance if already initialized
    if (appDataSource && appDataSource.isInitialized) {
        console.log(`[${requestId}] getDataSource: Returning existing initialized instance.`);
        return appDataSource;
    }

    // If initialization is in progress, wait for it
    if (initPromise) {
        console.log(`[${requestId}] getDataSource: Initialization in progress, awaiting...`);
        try {
            const ds = await initPromise;
            console.log(`[${requestId}] getDataSource: Initialization completed via await, returning instance.`);
            return ds;
        } catch (error) {
            console.error(`[${requestId}] getDataSource: Awaited initialization failed.`, error);
            // Reset promise if initialization failed
            initPromise = null;
            appDataSource = null; // Ensure appDataSource is also cleared
            throw error; // Rethrow the error
        }
    }

    // Start new initialization
    console.log(`[${requestId}] getDataSource: No instance or ongoing initialization. Starting new initialization.`);
    
    // Create a promise to track this initialization attempt
    initPromise = (async () => {
        console.log(`[${requestId}] getDataSource: Creating new NeonDataSource instance from context...`);
        
        // --- Configuration --- 
        const dbUrl = c.env.DATABASE_URL;
        if (!dbUrl) {
            throw new Error('DATABASE_URL not found in Hono context environment.');
        }
        const urlWithTimeout = addConnectTimeout(dbUrl);

        // Create options for our factory function
        const neonDataSourceOptions: NeonDataSourceOptions = {
            url: urlWithTimeout, // Use URL from context with timeout
            entities: Object.values(ServerEntities).filter(entity => typeof entity === 'function'),
            synchronize: c.env.NODE_ENV !== 'production',
            // Explicitly enable ALL logging for debugging
            logging: "all", 
            // Pass other options like namingStrategy if needed
        };

        // Use the factory function
        const ds = createNeonDataSource(neonDataSourceOptions);
        // Assign immediately AFTER creation, BEFORE initialize()
        appDataSource = ds; 

        try {
            console.log(`[${requestId}] getDataSource: Calling ds.initialize()...`);
            await ds.initialize(); 
            console.log(`[${requestId}] getDataSource: ds.initialize() successful.`);
            return ds;
        } catch (error) {
            console.error(`[${requestId}] getDataSource: Error during ds.initialize():`, error);
            appDataSource = null; // Clear the instance if initialization fails
            initPromise = null;  // Clear the promise if initialization fails
            throw error; // Rethrow to reject the initPromise
        }
    })();

    try {
        // Await the promise we just created
        const ds = await initPromise;
        console.log(`[${requestId}] getDataSource: Initial initialization successful, returning instance.`);
        return ds;
    } catch (error) {
         console.error(`[${requestId}] getDataSource: Initial initialization failed (error caught after awaiting initPromise).`, error);
         // Ensure promise is cleared on failure
         initPromise = null;
         appDataSource = null; // Ensure appDataSource is also cleared
         throw error; // Rethrow the error
    } finally {
         // Regardless of success or failure of this specific call's initialization attempt, 
         // clear the promise *if* it's the one we created. 
         // This allows subsequent calls to potentially retry initialization if the first one failed.
         // We only clear if the current initPromise is the one we created in this execution context.
         // This simple check might not be perfectly robust in highly concurrent scenarios without more complex locking,
         // but is better than unconditionally clearing. A more robust solution might involve comparing promise references.
         // For simplicity, let's assume this is sufficient for now.
         // If the initialization was successful, future calls will hit the "already initialized" path.
         // If it failed, this allows a retry.
         // initPromise = null; // Temporarily removing this to see if it causes issues. Let the success path handle keeping it.
         console.log(`[${requestId}] getDataSource: Exiting.`);
    }
}; 
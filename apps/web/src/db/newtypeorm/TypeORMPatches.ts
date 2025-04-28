/**
 * TypeORM Patches
 * 
 * This file contains patches for TypeORM internals to make them work with our custom driver.
 * These patches modify the prototype of TypeORM classes to ensure they work correctly with our
 * custom implementation.
 */

import { Broadcaster } from 'typeorm/subscriber/Broadcaster.js';
import { BroadcasterResult } from 'typeorm/subscriber/BroadcasterResult.js';

/**
 * Patches the TypeORM Broadcaster class to handle missing subscribers array safely.
 * 
 * This function must be called early in the application startup, before any TypeORM interactions.
 */
export function patchTypeORMBroadcaster() {
    // Store a reference to the original broadcastLoadEvent method
    const originalBroadcastLoadEvent = Broadcaster.prototype.broadcastLoadEvent;

    // Replace broadcastLoadEvent with our safe version
    Broadcaster.prototype.broadcastLoadEvent = function safelyPatchedBroadcastLoadEvent(
        result: BroadcasterResult,
        metadata: any,
        entities: any[]
    ) {
        try {
            // Call the original method
            return originalBroadcastLoadEvent.call(this, result, metadata, entities);
        } catch (error) {
            // Log the error but don't fail
            console.warn('[TypeORMPatch] Error in broadcastLoadEvent (safely caught):', error);
            // Return empty/default result - this function normally doesn't return anything
            return undefined;
        }
    };

    console.log('[TypeORMPatch] Successfully patched TypeORM Broadcaster');
}

/**
 * A more aggressive patch that completely replaces the broadcastLoadEvent method
 * with a no-op implementation. This should be used only if the safer patch above doesn't work.
 */
export function aggressivelyPatchTypeORMBroadcaster() {
    // Completely replace the broadcastLoadEvent method with a no-op
    Broadcaster.prototype.broadcastLoadEvent = function noopBroadcastLoadEvent() {
        // Do nothing
        return undefined;
    };

    console.log('[TypeORMPatch] Aggressively patched TypeORM Broadcaster (broadcastLoadEvent is now a no-op)');
} 
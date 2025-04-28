/**
 * TypeORM Patches Application
 * 
 * This file should be imported early in your application's startup to apply
 * patches to TypeORM internal classes.
 */

import { patchTypeORMBroadcaster, aggressivelyPatchTypeORMBroadcaster } from './TypeORMPatches';

// Apply all patches immediately when this file is imported
let alreadyApplied = false;

export function applyTypeORMPatches() {
    if (alreadyApplied) {
        console.log('TypeORM patches already applied, skipping');
        return;
    }
    
    console.log('Applying TypeORM patches...');
    
    try {
        patchTypeORMBroadcaster();
        console.log('Successfully applied TypeORM patches');
    } catch (error) {
        console.error('Error applying TypeORM patches:', error);
        
        // Try the aggressive patch as a fallback
        try {
            console.log('Trying aggressive patches as fallback...');
            aggressivelyPatchTypeORMBroadcaster();
            console.log('Successfully applied aggressive TypeORM patches');
        } catch (fallbackError) {
            console.error('Error applying aggressive TypeORM patches:', fallbackError);
        }
    }
    
    alreadyApplied = true;
}

// Apply patches immediately
applyTypeORMPatches(); 
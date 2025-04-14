import { OperationContext } from './scenario-runner.ts';
import { ClientChangesMessage, TableChange } from '@repo/sync-types';
import { User } from '@repo/dataforge/server-entities';
import { v4 as uuidv4 } from 'uuid';
import { TableChangeTest } from './entity-changes/types.ts';
import { 
    generateClientUniqueTaskChanges, 
    generateClientConflictUpdateChange,
    generateClientMixedSubmitChanges
} from './entity-changes/client-submit-changes.ts';
import { createLogger } from './logger.ts';

const logger = createLogger('core.client-actions');

// --- Start: Utility functions for case conversion ---
/**
 * Converts a camelCase string to snake_case.
 */
const camelToSnakeCase = (str: string) => str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/**
 * Transforms the keys of the data object in an array of TableChange objects
 * from camelCase to snake_case.
 */
export const transformChangesToSnakeCase = (changes: TableChange[]): TableChange[] => {
    return changes.map(change => {
        if (!change.data) {
            return change; // Skip if no data (e.g., delete)
        }
        const snakeCaseData: Record<string, any> = {};
        for (const key in change.data) {
            // Ensure the key is directly on the object, not from prototype
            if (Object.prototype.hasOwnProperty.call(change.data, key)) {
                snakeCaseData[camelToSnakeCase(key)] = change.data[key];
            }
        }
        // Return a new change object with the transformed data
        return {
            ...change,
            data: snakeCaseData
        };
    });
};
// --- End: Utility functions --- 

/**
 * Submits a predefined number of unique changes for each client.
 * Uses generateClientUniqueTaskChanges to get the payload.
 */
export async function submitUniqueClientChanges(context: OperationContext, operations: Record<string, any>) {
    const clientIds = context.state.clients as string[];
    const changesPerClient = context.config.customProperties?.changesPerClient || 3;
    logger.info(`Starting parallel submission of ${changesPerClient} unique changes per client...`);

    // Retrieve the User ID stored during setup
    const assigneeId = context.state.existingUserIdForClientGen;
    if (!assigneeId) {
        throw new Error('Existing user ID for client gen not found in context state.');
    }
    logger.info(`Using user ID ${assigneeId} from context state as assignee for client tasks.`);

    // Retrieve the default project ID from context state
    const defaultProjectId = context.state.defaultProjectId;
    if (!defaultProjectId) {
        throw new Error('Default project ID not found in context state.');
    }

    const submissionPromises = clientIds.map(async (clientId) => {
        const clientProfileId = context.state.clientProfiles[clientId];
        logger.info(`Client ${clientProfileId} (${clientId}) generating unique task changes...`);
        
        // Pass clientId to generation function
        const submittedChanges = await generateClientUniqueTaskChanges(
            changesPerClient, 
            defaultProjectId, 
            assigneeId,
            clientId // Pass the actual clientId
        );
        
        if (submittedChanges.length !== changesPerClient) {
             logger.warn(`Generated ${submittedChanges.length} task changes, expected ${changesPerClient}.`);
        }

        // Store original submitted changes in context state (camelCase)
        context.state.clientSubmittedChanges[clientId] = (context.state.clientSubmittedChanges[clientId] || []).concat(submittedChanges);
        
        // Transform changes to snake_case AFTER generation
        const snakeCaseChanges = transformChangesToSnakeCase(submittedChanges);

        // Construct and send the message
        const messagePayload: ClientChangesMessage = {
            type: 'clt_send_changes',
            messageId: `clt_submit_unique_${clientId}_${Date.now()}`,
            timestamp: Date.now(),
            clientId: clientId,
            changes: snakeCaseChanges
        };
        logger.info(`Client ${clientProfileId} sending ${snakeCaseChanges.length} generated unique changes (snake_case).`);
        logger.debug(`Data being sent by ${clientId}: ${JSON.stringify(snakeCaseChanges, null, 2)}`);
        
        await operations.ws.sendMessage(clientId, messagePayload);
        return { clientId, success: true, submittedCount: snakeCaseChanges.length };
    });

    const results = await Promise.all(submissionPromises);
    logger.info('All clients finished submitting unique changes.');
    return { success: true, results };
}

/**
 * Submits conflicting changes (updates to the same record) from multiple clients.
 * Uses generateClientConflictUpdateChange to get the payload.
 */
export async function submitConflictingClientChanges(context: OperationContext, operations: Record<string, any>) {
    const clientIds = context.state.clients as string[];
    const conflictRecordId = context.state.conflictTaskId;
    if (!conflictRecordId) {
        throw new Error('Conflict record ID not found in context state.');
    }
    logger.info(`Starting parallel submission of conflicting updates to record ${conflictRecordId}...`);

    const submissionPromises = clientIds.map(async (clientId, index) => {
        const clientProfileId = context.state.clientProfiles[clientId];
        
        // Pass clientId to generation function
        const conflictChange = generateClientConflictUpdateChange(
            conflictRecordId, 
            clientProfileId, 
            index, 
            clientId // Pass the actual clientId
        );

        // Store the single conflict change for validation
        context.state.clientConflictChanges[clientId] = conflictChange;
        // Also add it to the main submitted list for tracking
        context.state.clientSubmittedChanges[clientId] = (context.state.clientSubmittedChanges[clientId] || []).concat(conflictChange);

        // Transform change to snake_case AFTER generation
        const snakeCaseChange = transformChangesToSnakeCase([conflictChange])[0];

        // Construct and send the message
        const messagePayload: ClientChangesMessage = {
            type: 'clt_send_changes',
            messageId: `clt_${clientId}_${Date.now()}_conflict`,
            timestamp: Date.now(),
            clientId: clientId, // Keep this for potential header/meta usage
            changes: [snakeCaseChange] // <<< Wrap the single change in an array
        };
        logger.info(`Client ${clientProfileId} sending conflicting update (snake_case).`);
        logger.debug(`Conflicting data sent by ${clientId}: ${JSON.stringify(snakeCaseChange, null, 2)}`); // Log the single object for clarity
        
        await operations.ws.sendMessage(clientId, messagePayload);
        return { clientId, success: true };
    });

    const results = await Promise.all(submissionPromises);
    logger.info('All clients finished submitting conflicting changes.');
    return { success: true, results };
}

/**
 * Generates and submits a mix of unique changes, potentially including one conflict,
 * for all clients based on scenario config.
 */
export async function submitMixedClientChanges(context: OperationContext, operations: Record<string, any>) {
    const { 
        clientCount, 
        changesPerClient, 
        changeDistribution, 
        conflictConfig 
    } = context.state.scenarioConfig;
    
    const clientIds = context.state.clients as string[];
    const conflictRecordId = context.state.conflictTaskId;
    const assigneeId = context.state.existingUserIdForClientGen;
    const defaultProjectId = context.state.defaultProjectId;

    logger.info(`Starting parallel submission of ${changesPerClient} mixed changes per client...`);

    if (!assigneeId || !defaultProjectId) {
        throw new Error('Assignee ID or Default Project ID not found in context state. Ensure Step 1 ran correctly.');
    }

    // Prepare common existing IDs needed by generator
    const commonExistingIds = {
        projectId: defaultProjectId,
        assigneeId: assigneeId,
        ownerId: assigneeId
    };

    // Track conflict changes separately for validation
    const conflictChanges: Record<string, TableChangeTest> = {};

    const submissionPromises = clientIds.map(async (clientId, index) => {
        const clientProfileId = context.state.clientProfiles[clientId];
        logger.info(`Client ${clientProfileId} (${clientId}) generating ${changesPerClient} mixed changes...`);
        
        // Prepare conflict config for this specific client
        let specificConflictConfig = undefined;
        if (conflictConfig.enabled && conflictRecordId) {
            specificConflictConfig = {
                recordId: conflictRecordId,
                entity: conflictConfig.entity,
                field: conflictConfig.field,
                index: index
            };
            logger.info(`Client ${clientProfileId} will include conflict update (index: ${index})`);
        }

        // --- Generate Changes --- 
        const submittedChanges = await generateClientMixedSubmitChanges(
            changesPerClient,
            changeDistribution,
            clientId,
            commonExistingIds,
            specificConflictConfig,
            context
        );
        
        // Log all changes for debugging
        logger.debug(`Client ${clientId} generated changes (before storing):`);
        submittedChanges.forEach((change, idx) => {
            logger.debug(`  Change ${idx + 1}: ${change.operation} ${change.table} ${change.data?.id} (ts: ${change.updated_at})`);
            if (change.data?.id === conflictRecordId) {
                logger.debug(`    This is a conflict change with data: ${JSON.stringify(change.data)}`);
                conflictChanges[clientId] = change;
            }
        });
        
        // Store original submitted changes in context state (camelCase)
        context.state.clientSubmittedChanges[clientId] = submittedChanges;
        
        // Store conflict change if present
        const conflictChange = submittedChanges.find(c => 
            c.operation === 'update' && 
            c.data?.id === conflictRecordId
        );
        if (conflictChange) {
            context.state.clientConflictChanges[clientId] = conflictChange;
            logger.debug(`Stored conflict change for client ${clientId}: ${JSON.stringify(conflictChange)}`);
        } else if (conflictConfig.enabled) {
            logger.warn(`Expected conflict change not found in generated changes for client ${clientId}`);
        }

        if (submittedChanges.length !== changesPerClient) {
             logger.warn(`Client ${clientId} generated ${submittedChanges.length} changes, expected ${changesPerClient}.`);
        }

        // --- Transform and Send --- 
        const snakeCaseChanges = transformChangesToSnakeCase(submittedChanges);

        // Log transformed changes
        logger.debug(`Client ${clientId} snake_case changes (before sending):`);
        snakeCaseChanges.forEach((change, idx) => {
            logger.debug(`  Change ${idx + 1}: ${change.operation} ${change.table} ${change.data?.id} (ts: ${change.updated_at})`);
            if (change.data?.id === conflictRecordId) {
                logger.debug(`    This is a conflict change with data: ${JSON.stringify(change.data)}`);
            }
        });

        const messagePayload: ClientChangesMessage = {
            type: 'clt_send_changes',
            messageId: `clt_${clientId}_${Date.now()}_mixed`,
            timestamp: Date.now(),
            clientId: clientId,
            changes: snakeCaseChanges
        };
        logger.info(`Client ${clientProfileId} sending ${snakeCaseChanges.length} generated mixed changes (snake_case).`);
        
        await operations.ws.sendMessage(clientId, messagePayload);
        return { clientId, success: true, submittedCount: snakeCaseChanges.length };
    });

    // Wait for all submissions
    const results = await Promise.all(submissionPromises);
    
    // Check for any submission errors
    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
        logger.error(`${failures.length} client(s) failed to submit changes.`);
    }
    
    // Log conflict changes for validation
    if (conflictConfig.enabled && Object.keys(conflictChanges).length > 0) {
        logger.info('Summary of conflict changes:');
        for (const [clientId, change] of Object.entries(conflictChanges)) {
            const clientProfileId = context.state.clientProfiles[clientId];
            logger.info(`  Client ${clientProfileId}: ts=${change.updated_at}, data=${JSON.stringify(change.data)}`);
        }
    }
    
    logger.info('All clients finished submitting mixed changes.');
    return { success: failures.length === 0, results };
} 
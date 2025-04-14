/**
 * Client Submit Change Generation
 * 
 * Generates specific TableChange payloads needed for the client-submit-sync scenario.
 * Leverages the core batch-changes generation but provides tailored outputs.
 */
import { v4 as uuidv4 } from 'uuid';
import { User, Project, Task, Comment } from '@repo/dataforge/server-entities';
import { createTask, createComment, createProject } from './entity-factories.js';
import { generateMixedChanges } from './batch-changes.js';
import { EntityType } from './entity-adapter.js';
import { TableChangeTest, MixedChangesOptions } from './types.js';
import { TableChange } from '@repo/sync-types';
import { createLogger } from '../logger.js';

const logger = createLogger('ClientSubmitChanges');

/**
 * Default configuration values for entity distribution 
 */
export const DEFAULT_ENTITY_DISTRIBUTION = {
  task: 0.5,
  comment: 0.3,
  project: 0.2
};

/**
 * Default operation type distribution
 */
export const DEFAULT_OPERATION_DISTRIBUTION = {
  insert: 0.7,
  update: 0.3,
  delete: 0.0  // Deletes can be enabled when needed
};

/**
 * Default conflict configuration
 */
export const DEFAULT_CONFLICT_CONFIG = {
  enabled: true,
  entity: 'tasks',
  field: 'title',
  numberOfConflictTasks: 3,
  conflictBatchSize: 2,
  distribution: {
    type: 'overlap',
    overlapCount: 1
  }
};

/**
 * Generates a specified number of unique Task insert changes manually.
 * 
 * @param count Number of task insert changes to generate.
 * @param projectId The Project ID to associate tasks with.
 * @param assigneeId The User ID to assign tasks to.
 * @param clientId The UUID of the client submitting the change.
 * @returns Promise resolving to an array of TableChangeTest objects.
 */
export async function generateClientUniqueTaskChanges(
    count: number, 
    projectId: string, 
    assigneeId: string,
    clientId: string
): Promise<TableChangeTest[]> {
    logger.info(`Generating ${count} unique task insert changes manually for project ${projectId}...`);
    const changes: TableChangeTest[] = [];
    
    if (!projectId || !assigneeId) {
        logger.error('Project ID or Assignee ID is missing for task generation.');
        throw new Error('Missing required IDs for generating client task changes.');
    }

    for (let i = 0; i < count; i++) {
        const taskId = uuidv4();
        // Construct data payload (camelCase)
        const taskData = {
            id: taskId,
            title: `Client Task ${i + 1} (Unique ${Date.now()})`,
            projectId: projectId,
            assigneeId: assigneeId,
            status: 'open', // Use valid enum value
            clientId: clientId // Add clientId to the data payload
            // Add any other necessary default fields if Task entity requires them
        };

        const change: TableChangeTest = {
            table: 'tasks',
            operation: 'insert',
            data: taskData,
            updated_at: new Date().toISOString(), // Follow TableChange structure
            // batchId: ?? // batchId might be added later or isn't needed for client->server
        };
        changes.push(change);
    }

    logger.info(`Successfully generated ${changes.length} manual task insert changes.`);
    return changes;
}

/**
 * Generates the specific 'update' TableChange payload for the conflict test.
 * 
 * @param taskId The ID of the task to update.
 * @param clientProfileId Identifier for the client submitting the change (for logging/tracking).
 * @param index Differentiator for multiple clients updating the same record.
 * @param clientId The UUID of the client submitting the change.
 * @returns A TableChange object representing the conflicting update.
 */
export function generateClientConflictUpdateChange(
    taskId: string, 
    clientProfileId: number | string, 
    index: number,
    clientId: string
): TableChangeTest {
    logger.info(`Generating conflicting update change for task ${taskId} from client ${clientProfileId}`);
    
    // Create deterministic timestamps where each client's update is 1 second later than the previous
    // This ensures the last client's update will always win
    const baseTime = new Date('2025-04-10T01:41:11.000Z').getTime();
    const offsetMs = index * 1000; // 1 second gap between each client
    const timestamp = new Date(baseTime + offsetMs).toISOString();
    
    logger.debug(`Generated timestamp for client ${clientId} (index ${index}): ${timestamp}`);
    
    // Keep data camelCase initially, transformation happens later in client-actions
    const conflictUpdateData = { 
        id: taskId, // Primary key
        title: `Conflict Update from Client ${clientProfileId} (${index})`, 
        updatedAt: timestamp,
        clientId: clientId // Add clientId to the data payload
    };

    const conflictChange: TableChangeTest = {
        table: 'tasks',
        operation: 'update',
        data: conflictUpdateData,
        updated_at: timestamp, // Use same deterministic timestamp
        _isConflict: true // Mark this as a conflict change
    };

    logger.debug(`Generated conflict change for client ${clientId} (index ${index}): ${JSON.stringify(conflictChange)}`);
    return conflictChange;
}

/**
 * Selects a random entity type based on the provided distribution weights.
 * @param distribution - Record mapping entity names to fractional weights (summing to 1).
 * @returns The name of the selected entity type (e.g., 'task', 'comment').
 */
function selectEntityType(distribution: Record<string, number>): string {
    const rand = Math.random();
    let cumulative = 0;
    for (const entityType in distribution) {
        cumulative += distribution[entityType];
        if (rand < cumulative) {
            return entityType;
        }
    }
    // Fallback to the last key in case of floating point nuances
    return Object.keys(distribution).pop() || 'task'; 
}

// Helper function to get random change type based on distribution
function getRandomChangeType(distribution: Record<string, number>): string {
    const total = Object.values(distribution).reduce((a, b) => a + b, 0);
    let random = Math.random() * total;
    for (const [type, weight] of Object.entries(distribution)) {
        random -= weight;
        if (random <= 0) return type;
    }
    return Object.keys(distribution)[0]; // Fallback
}

// Helper functions to generate specific change types
async function generateTaskChange(projectId: string, assigneeId: string, clientId: string): Promise<TableChangeTest | null> {
    try {
        const task = await createTask(
            { assignee: { id: assigneeId } as User, project: { id: projectId } as Project },
            { title: `Client ${clientId} Task (${Date.now()})` }
        );
        return {
            table: 'tasks',
            operation: 'insert',
            data: { ...task, clientId },
            updated_at: new Date().toISOString()
        };
    } catch (error) {
        logger.error(`Error generating task change: ${error}`);
        return null;
    }
}

async function generateCommentChange(projectId: string, authorId: string, clientId: string): Promise<TableChangeTest | null> {
    try {
        const comment = await createComment(
            { author: { id: authorId } as User },
            {
                content: `Client ${clientId} Comment (${Date.now()})`,
                entityId: projectId,
                entityType: 'project'
            }
        );
        return {
            table: 'comments',
            operation: 'insert',
            data: { ...comment, clientId },
            updated_at: new Date().toISOString()
        };
    } catch (error) {
        logger.error(`Error generating comment change: ${error}`);
        return null;
    }
}

async function generateProjectChange(ownerId: string, clientId: string): Promise<TableChangeTest | null> {
    try {
        const project = await createProject(
            { owner: { id: ownerId } as User },
            { 
                name: `Client-${clientId.slice(0, 8)}-Project-${Date.now()}`
            }
        );
        return {
            table: 'projects',
            operation: 'insert',
            data: { ...project, clientId },
            updated_at: new Date().toISOString()
        };
    } catch (error) {
        logger.error(`Error generating project change: ${error}`);
        return null;
    }
}

/**
 * Generates a mix of client changes including potential conflict updates.
 * 
 * @param count Number of changes to generate
 * @param distribution Distribution of entity types (or uses DEFAULT_ENTITY_DISTRIBUTION)
 * @param clientId The client ID generating the changes
 * @param existingIds Existing entity IDs to reference
 * @param conflictOptions Optional conflict configuration
 * @returns Array of TableChangeTest objects
 */
export async function generateClientMixedSubmitChanges(
    count: number,
    distribution: Record<string, number> | undefined,
    clientId: string,
    existingIds: {
        projectId?: string;
        assigneeId?: string;
        ownerId?: string;
    },
    conflictOptions?: {
        recordId: string;
        entity: string;
        field: string;
        index: number;
    }
): Promise<TableChangeTest[]> {
    // Use default distribution if not provided
    const entityDistribution: Record<string, number> = distribution || DEFAULT_ENTITY_DISTRIBUTION;
    
    logger.info(`Generating ${count} mixed changes for client ${clientId} with distribution: ${JSON.stringify(entityDistribution)}`);
    
    // Generate base changes (non-conflict)
    let changes: TableChangeTest[] = [];
    
    // Count of non-conflict changes to generate (all if no conflict, count-1 if conflict)
    const nonConflictCount = conflictOptions ? count - 1 : count;
    
    // Add unique entity changes
    if (nonConflictCount > 0) {
        // Create unique mixed changes for most of the requested count
        for (const entityType of Object.keys(entityDistribution)) {
            const entityTypeShare = entityDistribution[entityType] || 0;
            const entityCount = Math.round(nonConflictCount * entityTypeShare);
            if (entityCount <= 0) continue;
            
            logger.debug(`Generating ${entityCount} ${entityType} changes for client ${clientId}`);
            
            let entityChanges: TableChangeTest[] = [];
            
            switch (entityType) {
                case 'task':
                    entityChanges = await generateClientUniqueTaskChanges(
                        entityCount,
                        existingIds.projectId!,
                        existingIds.assigneeId!,
                        clientId
                    );
                    break;
                case 'comment':
                    // Use task changes as a fallback since we haven't implemented comment changes yet
                    entityChanges = await generateClientUniqueTaskChanges(
                        entityCount,
                        existingIds.projectId!,
                        existingIds.assigneeId!,
                        clientId
                    );
                    break;
                case 'project':
                    // Use task changes as a fallback since we haven't implemented project changes yet
                    entityChanges = await generateClientUniqueTaskChanges(
                        entityCount,
                        existingIds.projectId!,
                        existingIds.assigneeId!,
                        clientId
                    );
                    break;
                default:
                    logger.warn(`Unknown entity type: ${entityType}, skipping`);
            }
            
            changes = changes.concat(entityChanges);
        }
    }
    
    // Add conflict change if needed
    if (conflictOptions) {
        const conflictChange = generateClientConflictUpdateChange(
            conflictOptions.recordId,
            clientId, // Use clientId as the clientProfileId parameter
            conflictOptions.index,
            clientId  // Pass clientId again as the last parameter
        );
        changes.push(conflictChange);
    }
    
    logger.info(`Generated ${changes.length} total changes for client ${clientId}`);
    return changes;
}

export async function generateClientConflictTaskChanges(
    taskId: string,
    clientId: string,
    clientName: string
): Promise<TableChangeTest[]> {
    const logger = createLogger('generateClientConflictTaskChanges');
    const options: MixedChangesOptions = {
        batchSize: 1,
        distribution: { task: 1.0 }
    };
    const result = await generateMixedChanges(options);
    logger.info(`Generated ${result.changes.length} task changes`);
    return result.changes;
} 
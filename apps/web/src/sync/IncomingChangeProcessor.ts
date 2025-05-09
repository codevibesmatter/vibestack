import { TableChange } from '@repo/sync-types';
import { ChangeProcessor } from '../db/change-processor'; // Import the DB layer's processor
import { SyncEventEmitter } from './SyncEventEmitter';
import { EntityManager } from 'typeorm';
import {
  Comment,
  Project,
  Task,
  User,
  TaskStatus,
  TaskPriority,
} from '@repo/dataforge/client-entities';
import { getNewPGliteDataSource } from '../db/newtypeorm/NewDataSource';

const INCOMING_BATCH_SIZE = 250; // Batch size for TypeORM save operations
export class IncomingChangeProcessor {
  private dbChangeProcessor: ChangeProcessor;
  private events: SyncEventEmitter;
  private isProcessing: boolean = false; // To prevent concurrent processing if needed

  constructor(eventEmitter: SyncEventEmitter) {
    this.events = eventEmitter;
    // Instantiate the DB ChangeProcessor.
    // Consider if this needs to be injected or if creating it here is appropriate.
    // For now, let's instantiate it directly. It has its own internal initialization.
    this.dbChangeProcessor = new ChangeProcessor();
  }

  /**
   * Processes a batch of incoming changes from the server by delegating
   * to the database layer's ChangeProcessor.
   * @param changes - Array of table changes received from the server.
   * @param messageType - The type of server message these changes came from (e.g., 'srv_live_changes').
   * @returns Promise<boolean> - True if processing was successful, false otherwise.
   */
  public async processIncomingChanges(changes: TableChange[], messageType: string): Promise<boolean> {
    if (this.isProcessing) {
      console.warn(`IncomingChangeProcessor: Already processing a batch, skipping new batch from ${messageType}`);
      return false; // Or queue, but for now, skip
    }
    if (!changes || changes.length === 0) {
      console.log(`IncomingChangeProcessor: No changes to process for ${messageType}.`);
      return true; // Nothing to do is considered success
    }

    this.isProcessing = true;
    console.log(`IncomingChangeProcessor: Processing ${changes.length} incoming changes via dbChangeProcessor (${messageType})...`);
    const startTime = Date.now();

    try {
      // Ensure the dbChangeProcessor is initialized (it handles its own initialization check)
      // await this.dbChangeProcessor.initialize(); // dbChangeProcessor handles this internally now

      // Delegate the entire batch processing (including transactions)
      await this.dbChangeProcessor.processBatch(changes);

      const processingTime = Date.now() - startTime;
      console.log(`IncomingChangeProcessor: Successfully processed batch via dbChangeProcessor in ${processingTime}ms (${messageType}).`);
      this.events.emit('incoming_changes_processed', { success: true, count: changes.length, type: messageType });
      return true;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`IncomingChangeProcessor: Error processing batch via dbChangeProcessor (${messageType}, took ${processingTime}ms):`, error);
      this.events.emit('incoming_changes_processed', {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        count: changes.length,
        type: messageType
      });
      return false;
    } finally {
      this.isProcessing = false;
    }
  }
  private formatValueForSQL(column: string, value: any, table: string): string {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return 'NULL';
    }

    // Handle specific types based on column name or type inspection (if possible)
    // Example for Task entity enums
    if (table === 'tasks') {
      // Handle TaskStatus enum
      if (column === 'status' && typeof value === 'string') {
        // Validate against enum values if necessary
        const validStatuses = Object.values(TaskStatus);
        if (validStatuses.includes(value as TaskStatus)) {
          return `'${value.replace(/'/g, "''")}'`; // Escape single quotes
        } else {
          console.warn(`Invalid TaskStatus value: ${value}`);
          return 'NULL'; // Or throw error, or use default
        }
      }
      // Handle TaskPriority enum
      if (column === 'priority' && typeof value === 'string') {
        const validPriorities = Object.values(TaskPriority);
        if (validPriorities.includes(value as TaskPriority)) {
          return `'${value.replace(/'/g, "''")}'`;
        } else {
          console.warn(`Invalid TaskPriority value: ${value}`);
          return `'medium'`; // Default priority
        }
      }
      // Handle Date types (dueDate, completedAt)
      if (column === 'dueDate' || column === 'due_date' || column === 'completedAt' || column === 'completed_at') {
        // Check if it's already an ISO string
        if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
          return `'${value.replace(/'/g, "''")}'`;
        }
        if (value instanceof Date) {
          return `'${value.toISOString().replace(/'/g, "''")}'`;
        }
        // Attempt to parse if it's a different string format (add more robust parsing if needed)
        try { return `'${new Date(value).toISOString().replace(/'/g, "''")}'`; } catch (e) { return 'NULL'; }
      }
      // Handle tsrange (timeRange) - requires specific formatting '[start, end)'
      if (column === 'timeRange' || column === 'time_range') {
        // Assuming value is { from: Date | string, to: Date | string }
        if (typeof value === 'string') {
          // Basic check if it looks like a range string already
          if (value.startsWith('[') && value.endsWith(')')) return `'${value.replace(/'/g, "''")}'`;
          return 'NULL'; // Cannot parse unknown string format
        }
        if (typeof value === 'object' && value.from && value.to) {
          const from = value.from instanceof Date ? value.from.toISOString() : value.from;
          const to = value.to instanceof Date ? value.to.toISOString() : value.to;
          return `'[${from}, ${to})'`;
        }
        return 'NULL';
      }
      // Handle interval (estimatedDuration) - e.g., '1 hour', '2 days'
      if (column === 'estimatedDuration' || column === 'estimated_duration') {
        if (typeof value === 'string') {
          // Basic interval format check (this is simplified)
          if (value.match(/^\d+\s+(hour|day|week|month)s?$/)) {
            return `'${value.replace(/'/g, "''")}'`;
          }
        }
        // Add more robust interval parsing/formatting if needed
        return 'NULL';
      }
      // Handle text array (tags)
      if (column === 'tags' && Array.isArray(value)) {
        // Format as '{ "tag1", "tag2" }'
        const arrayStr = value.map(item => `"${String(item).replace(/"/g, '\\"')}"`).join(',');
        return `'{${arrayStr}}'`;
      }
    }

    // Handle general types
    if (typeof value === 'string') {
      // Escape single quotes for SQL strings
      return `'${value.replace(/'/g, "''")}'`;
    }
    if (value instanceof Date) {
      // Format dates as ISO strings
      return `'${value.toISOString()}'`;
    }
    if (typeof value === 'boolean') {
      // Convert booleans to true/false literals
      return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
      // Numbers are used directly
      return String(value);
    }
    if (typeof value === 'object') {
      // Stringify JSON objects/arrays
      try {
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
      } catch (e) {
        console.error(`Error stringifying object for column ${column}:`, value, e);
        return 'NULL';
      }
    }

    // Fallback for unknown types
    console.warn(`Unhandled type for column ${column}: ${typeof value}`);
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private getEntityRepository(manager: EntityManager, conceptualTableName: string) {
    // Map conceptual name to actual entity class
    switch (conceptualTableName) {
      case 'comments':
        return manager.getRepository(Comment);
      case 'projects':
        return manager.getRepository(Project);
      case 'tasks':
        return manager.getRepository(Task);
      case 'users':
        return manager.getRepository(User);
      // Add other entities as needed
      default:
        console.error(`IncomingChangeProcessor: Unknown conceptual table name '${conceptualTableName}' encountered in getEntityRepository.`);
        throw new Error(`No repository found for conceptual table name: ${conceptualTableName}`);
    }
  }

  private async isValidTable(tableName: string): Promise<boolean> {
    const dataSource = await getNewPGliteDataSource();
    if (!dataSource) return false; // Cannot validate without schema info
    // Check if the table name corresponds to a known entity managed by TypeORM
    try {
      const metadata = dataSource.getMetadata(tableName);
      // Alternative: Check against a predefined list of syncable tables
      // const syncableTables = ['comments', 'projects', 'tasks', 'users'];
      // return syncableTables.includes(tableName);
      return !!metadata;
    } catch (e) {
      // getMetadata throws if not found
      return false;
    }
  }
  private getEntityTableName(conceptualTableName: string): string | null {
    // Simple 1:1 mapping for now, assuming conceptual names match DB table names
    // after potential case conversion (which TypeORM handles)
    switch (conceptualTableName) {
        case 'comments': return 'comments';
        case 'projects': return 'projects';
        case 'tasks': return 'tasks';
        case 'users': return 'users';
        // Add other known tables
        default:
            console.warn(`IncomingChangeProcessor: Unknown conceptual table name '${conceptualTableName}' encountered in getEntityTableName.`);
            return null;
    }
  }
}
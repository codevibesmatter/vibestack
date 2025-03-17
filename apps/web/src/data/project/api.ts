import { getDatabase } from '../../db/core';
import { workerManager } from '../../sync/worker-manager';
import { dbMessageBus } from '../../db/message-bus';
import { getLSNManager } from '../../sync/lsn-manager';
import { changesLogger } from '../../utils/logger';

export interface Project {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DELETED';
  member_ids: string[];
  created_at: number;
  updated_at: number;
}

// Initialize LSN manager
const lsnManager = getLSNManager();
lsnManager.initialize().catch(err => {
  changesLogger.logServiceError('Failed to initialize LSN manager', err);
});

/**
 * Get all projects
 */
export async function getProjects(): Promise<Project[]> {
  const db = await getDatabase();
  const result = await db.query<Project>(`SELECT * FROM "projects"`);
  return result.rows;
}

/**
 * Get a project by ID
 */
export async function getProjectById(projectId: string): Promise<Project | null> {
  const db = await getDatabase();
  const result = await db.query<Project>(
    `SELECT * FROM "projects" WHERE id = $1`,
    [projectId]
  );
  return result.rows[0] || null;
}

/**
 * Create a new project
 */
export async function createProject(project: Partial<Project>): Promise<Project> {
  changesLogger.logServiceEvent('Creating new project');
  
  const db = await getDatabase();
  
  try {
    // Ensure LSN manager is initialized
    await lsnManager.initialize();
    
    // Get the client ID
    const clientId = await lsnManager.getClientId();
    if (!clientId) {
      throw new Error('No client ID available - sync service may not be initialized');
    }
    
    // Start transaction
    await db.query(`BEGIN`);
    
    // Insert into local database
    const result = await db.query<Project>(
      `INSERT INTO "projects" (
        name, description, owner_id, status, member_ids
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [
        project.name,
        project.description,
        project.owner_id,
        project.status || 'ACTIVE',
        project.member_ids || []
      ]
    );

    const newProject = result.rows[0];

    // Send change to sync system
    workerManager.sendMessage('client_change', {
      type: 'client_change',
      clientId,
      change: {
        table: 'Project',
        operation: 'insert',
        data: {
          ...newProject,
          client_id: clientId
        }
      },
      metadata: {
        timestamp: Date.now()
      }
    });

    // Also publish change event for UI updates
    dbMessageBus.publish('change_recorded', {
      entity_type: 'Project',
      entity_id: newProject.id,
      operation: 'insert',
      data: newProject,
      old_data: null,
      timestamp: Date.now()
    });

    // Commit transaction
    await db.query(`COMMIT`);

    return newProject;
  } catch (error) {
    // Rollback on error
    await db.query(`ROLLBACK`);
    changesLogger.logServiceError('Failed to create project', error);
    throw error;
  }
}

/**
 * Update a project
 */
export async function updateProject(projectId: string, updates: Partial<Project>): Promise<Project> {
  changesLogger.logServiceEvent(`Updating project: ${projectId}`);
  
  const db = await getDatabase();
  
  try {
    // Ensure LSN manager is initialized
    await lsnManager.initialize();
    
    // Get the client ID
    const clientId = await lsnManager.getClientId();
    if (!clientId) {
      throw new Error('No client ID available - sync service may not be initialized');
    }
    
    // Start transaction
    await db.query(`BEGIN`);
    
    // Get current project data for old_data
    const current = await db.query<Project>(
      `SELECT * FROM "projects" WHERE id = $1`,
      [projectId]
    );

    if (current.rows.length === 0) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const oldData = current.rows[0];

    // Update in local database
    const result = await db.query<Project>(
      `UPDATE "projects" 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           member_ids = COALESCE($4, member_ids)
       WHERE id = $5
       RETURNING *`,
      [
        updates.name,
        updates.description,
        updates.status,
        updates.member_ids,
        projectId
      ]
    );

    const updatedProject = result.rows[0];

    // Send change to sync system
    workerManager.sendMessage('client_change', {
      type: 'client_change',
      clientId,
      change: {
        table: 'Project',
        operation: 'update',
        data: {
          ...updatedProject,
          client_id: clientId
        },
        old_data: oldData
      },
      metadata: {
        timestamp: Date.now()
      }
    });

    // Also publish change event for UI updates
    dbMessageBus.publish('change_recorded', {
      entity_type: 'Project',
      entity_id: projectId,
      operation: 'update',
      data: updatedProject,
      old_data: oldData,
      timestamp: Date.now()
    });

    // Commit transaction
    await db.query(`COMMIT`);

    return updatedProject;
  } catch (error) {
    // Rollback on error
    await db.query(`ROLLBACK`);
    changesLogger.logServiceError('Failed to update project', error);
    throw error;
  }
}

/**
 * Delete a project
 */
export async function deleteProject(projectId: string): Promise<void> {
  changesLogger.logServiceEvent(`Deleting project: ${projectId}`);
  
  const db = await getDatabase();
  
  try {
    // Ensure LSN manager is initialized
    await lsnManager.initialize();
    
    // Get the client ID
    const clientId = await lsnManager.getClientId();
    if (!clientId) {
      throw new Error('No client ID available - sync service may not be initialized');
    }
    
    // Start transaction
    await db.query(`BEGIN`);
    
    // Get current project data for old_data
    const current = await db.query<Project>(
      `SELECT * FROM "projects" WHERE id = $1`,
      [projectId]
    );

    if (current.rows.length === 0) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const oldData = current.rows[0];

    // Delete from local database
    await db.query(
      `DELETE FROM "projects" WHERE id = $1`,
      [projectId]
    );

    // Send change to sync system
    workerManager.sendMessage('client_change', {
      type: 'client_change',
      clientId,
      change: {
        table: 'Project',
        operation: 'delete',
        data: null,
        old_data: oldData
      },
      metadata: {
        timestamp: Date.now()
      }
    });

    // Also publish change event for UI updates
    dbMessageBus.publish('change_recorded', {
      entity_type: 'Project',
      entity_id: projectId,
      operation: 'delete',
      data: null,
      old_data: oldData,
      timestamp: Date.now()
    });

    // Commit transaction
    await db.query(`COMMIT`);
  } catch (error) {
    // Rollback on error
    await db.query(`ROLLBACK`);
    changesLogger.logServiceError('Failed to delete project', error);
    throw error;
  }
}

/**
 * Get all projects with filters
 */
export async function getAllProjects(options: {
  limit?: number;
  offset?: number;
  orderBy?: string;
  owner_id?: string;
  status?: string;
} = {}): Promise<Project[]> {
  const db = await getDatabase();
  const params: any[] = [];
  let sql = 'SELECT * FROM "Project"';
  const conditions: string[] = [];

  // Add WHERE conditions
  if (options.owner_id) {
    params.push(options.owner_id);
    conditions.push(`"owner_id" = $${params.length}`);
  }
  
  if (options.status) {
    params.push(options.status);
    conditions.push(`status = $${params.length}`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  // Add ORDER BY
  if (options.orderBy) {
    sql += ` ORDER BY "${options.orderBy}"`;
  }

  // Add LIMIT and OFFSET
  if (options.limit) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  if (options.offset) {
    params.push(options.offset);
    sql += ` OFFSET $${params.length}`;
  }

  const result = await db.query<Project>(sql, params);
  return result.rows;
}

/**
 * Get projects by owner ID
 */
export async function getProjectsByOwnerId(owner_id: string): Promise<Project[]> {
  const db = await getDatabase();
  const result = await db.query<Project>(
    'SELECT * FROM "Project" WHERE "owner_id" = $1 ORDER BY "created_at" DESC',
    [owner_id]
  );
  return result.rows;
}

/**
 * Get projects by status
 */
export async function getProjectsByStatus(status: string): Promise<Project[]> {
  const db = await getDatabase();
  const result = await db.query<Project>(
    'SELECT * FROM "Project" WHERE status = $1 ORDER BY "created_at" DESC',
    [status]
  );
  return result.rows;
}

/**
 * Search projects by name pattern
 */
export async function searchProjectsByName(namePattern: string): Promise<Project[]> {
  const db = await getDatabase();
  const result = await db.query<Project>(
    'SELECT * FROM "Project" WHERE name ILIKE $1 ORDER BY name',
    [`%${namePattern}%`]
  );
  return result.rows;
} 
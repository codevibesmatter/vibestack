import { Client } from '@neondatabase/serverless';
import { Task, TaskStatus, TaskPriority } from "@repo/typeorm/server-entities";
import { validate } from "class-validator";

// Re-export enums for convenience
export { TaskStatus, TaskPriority };

// Simplified type definitions
type TaskInstance = Task;

// Input types for API
export type TaskCreateInput = Partial<Omit<TaskInstance, 'id' | 'created_at' | 'updated_at'>>;
export type TaskUpdateInput = Partial<TaskCreateInput>;

// Database operations
export const taskQueries = {
  findAll: async (client: Client): Promise<TaskInstance[]> => {
    const result = await client.query<TaskInstance>(
      `SELECT * FROM "tasks" ORDER BY "created_at" DESC`
    );
    return result.rows;
  },

  findById: async (client: Client, id: string): Promise<TaskInstance | null> => {
    const result = await client.query<TaskInstance>(
      `SELECT t.*, array_agg(td.dependency_task_id) as dependency_ids FROM "tasks" t
       LEFT JOIN task_dependencies td ON t.id = td.dependent_task_id
       WHERE t.id = $1
       GROUP BY t.id`,
      [id]
    );
    return result.rows[0] || null;
  },

  findByProjectId: async (client: Client, projectId: string): Promise<TaskInstance[]> => {
    const result = await client.query<TaskInstance>(
      `SELECT t.*, array_agg(td.dependency_task_id) as dependency_ids FROM "tasks" t
       LEFT JOIN task_dependencies td ON t.id = td.dependent_task_id
       WHERE t.project_id = $1
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
      [projectId]
    );
    return result.rows;
  },

  findByAssigneeId: async (client: Client, assigneeId: string): Promise<TaskInstance[]> => {
    const result = await client.query<TaskInstance>(
      `SELECT t.*, array_agg(td.dependency_task_id) as dependency_ids FROM "tasks" t
       LEFT JOIN task_dependencies td ON t.id = td.dependent_task_id
       WHERE t.assignee_id = $1
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
      [assigneeId]
    );
    return result.rows;
  },

  findByStatus: async (client: Client, status: typeof TaskStatus[keyof typeof TaskStatus]): Promise<TaskInstance[]> => {
    const result = await client.query<TaskInstance>(
      `SELECT t.*, array_agg(td.dependency_task_id) as dependency_ids FROM "tasks" t
       LEFT JOIN task_dependencies td ON t.id = td.dependent_task_id
       WHERE t.status = $1
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
      [status]
    );
    return result.rows;
  },

  create: async (client: Client, data: TaskCreateInput): Promise<TaskInstance> => {
    // Create instance for validation using TypeORM entity
    const task = new Task();
    Object.assign(task, {
      ...data,
      status: data.status || TaskStatus.OPEN,
      priority: data.priority || TaskPriority.MEDIUM
    });
    
    // Leverage class-validator decorators from TypeORM entity
    const errors = await validate(task);
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }

    // Use TypeORM column definitions for SQL
    const columns = Object.keys(data).map(key => `"${key}"`).join(", ");
    const values = Object.values(data);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const result = await client.query<TaskInstance>(
      `INSERT INTO "tasks" (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.rows[0];
  },

  update: async (client: Client, id: string, data: TaskUpdateInput): Promise<TaskInstance | null> => {
    // Create instance for validation using TypeORM entity
    const task = new Task();
    Object.assign(task, { id, ...data });
    
    // Leverage class-validator decorators from TypeORM entity
    const errors = await validate(task, { skipMissingProperties: true });
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
    }

    const setClause = Object.keys(data)
      .map((key, index) => `"${key}" = $${index + 2}`)
      .join(", ");
    
    const values = [id, ...Object.values(data)];
    const result = await client.query<TaskInstance>(
      `UPDATE "tasks" SET ${setClause} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows[0] || null;
  },

  updateStatus: async (client: Client, id: string, status: typeof TaskStatus[keyof typeof TaskStatus]): Promise<TaskInstance | null> => {
    const now = new Date();
    const completedAt = status === TaskStatus.COMPLETED ? now : null;
    
    const result = await client.query<TaskInstance>(
      `UPDATE "tasks" SET status = $2, "completed_at" = $3 WHERE id = $1 RETURNING *`,
      [id, status, completedAt]
    );
    return result.rows[0] || null;
  },

  updateTimeRange: async (client: Client, id: string, timeRange: string): Promise<TaskInstance | null> => {
    const result = await client.query<TaskInstance>(
      `UPDATE "tasks" SET "time_range" = $2 WHERE id = $1 RETURNING *`,
      [id, timeRange]
    );
    return result.rows[0] || null;
  },

  addDependency: async (client: Client, taskId: string, dependencyId: string): Promise<TaskInstance | null> => {
    await client.query(
      `INSERT INTO task_dependencies (dependent_task_id, dependency_task_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [taskId, dependencyId]
    );
    
    return taskQueries.findById(client, taskId);
  },

  removeDependency: async (client: Client, taskId: string, dependencyId: string): Promise<TaskInstance | null> => {
    await client.query(
      `DELETE FROM task_dependencies
       WHERE dependent_task_id = $1 AND dependency_task_id = $2`,
      [taskId, dependencyId]
    );
    
    return taskQueries.findById(client, taskId);
  },

  addTag: async (client: Client, id: string, tag: string): Promise<TaskInstance | null> => {
    const result = await client.query<TaskInstance>(
      `UPDATE "tasks" SET tags = array_append(tags, $2) 
       WHERE id = $1 AND NOT $2 = ANY(tags) RETURNING *`,
      [id, tag]
    );
    return result.rows[0] || null;
  },

  removeTag: async (client: Client, id: string, tag: string): Promise<TaskInstance | null> => {
    const result = await client.query<TaskInstance>(
      `UPDATE "tasks" SET tags = array_remove(tags, $2) 
       WHERE id = $1 RETURNING *`,
      [id, tag]
    );
    return result.rows[0] || null;
  },

  delete: async (client: Client, id: string): Promise<boolean> => {
    // First delete all dependencies
    await client.query(
      `DELETE FROM task_dependencies WHERE dependent_task_id = $1 OR dependency_task_id = $1`,
      [id]
    );
    
    // Then delete the task
    const result = await client.query(
      `DELETE FROM "tasks" WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}; 
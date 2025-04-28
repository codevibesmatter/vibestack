import { db, DbTask, DbUser, DbProject, DbComment } from './db';
import { TaskStatus, TaskPriority } from '@repo/dataforge/client-entities';
import { v4 as uuidv4 } from 'uuid';
import { SyncChangeManager } from '../sync/SyncChangeManager.typeorm';

/**
 * Data service error class
 */
export class DatabaseServiceError extends Error {
  constructor(message: string, public operation: string, public originalError?: unknown) {
    super(message);
    this.name = 'DatabaseServiceError';
  }
}

/**
 * User service for user-related operations
 */
export const UserService = {
  /**
   * Get a user by ID
   */
  async getById(id: string) {
    try {
      return await db.users.get(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get user with ID ${id}`,
        'getById',
        error
      );
    }
  },

  /**
   * Get all users
   */
  async getAll() {
    try {
      return await db.users.toArray();
    } catch (error) {
      throw new DatabaseServiceError(
        'Failed to get all users',
        'getAll',
        error
      );
    }
  },

  /**
   * Create a new user
   */
  async create(user: Partial<DbUser> & { name: string; email: string }) {
    try {
      const now = new Date();
      const userId = user.id || uuidv4();
      const changeManager = SyncChangeManager.getInstance();
      const clientId = changeManager.getClientId();

      const newUser = {
        id: userId,
        name: user.name,
        email: user.email,
        // Add other default fields if necessary for DbUser
        createdAt: now,
        updatedAt: now
      } as DbUser;

      await db.transaction('rw', [db.users, db.localChanges], async () => {
        await db.users.add(newUser);
        await changeManager.trackChange(
          'users',
          'insert',
          newUser as unknown as Record<string, unknown>
        );
      });

      console.log(`User created: ${userId}`, newUser);
      return newUser;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create user "${user.name}"`,
        'create',
        error
      );
    }
  },

  /**
   * Update an existing user
   */
  async update(id: string, changes: Partial<DbUser>) {
    try {
      const now = new Date();
      let updatedUser: DbUser | null = null;
      const changeManager = SyncChangeManager.getInstance();
      const clientId = changeManager.getClientId();

      await db.transaction('rw', [db.users, db.localChanges], async () => {
        const user = await db.users.get(id);
        if (!user) {
          throw new Error(`User with ID ${id} not found`);
        }

        // Create updated user object
        updatedUser = {
          ...user,
          ...changes,
          updatedAt: now
        };

        // Update the user in the database
        await db.users.update(id, { ...changes, updatedAt: now });

        await changeManager.trackChange(
          'users',
          'update',
          updatedUser as unknown as Record<string, unknown>
        );
      });

      if (!updatedUser) {
        throw new Error(`Failed to update user with ID ${id}`);
      }

      console.log(`User updated: ${id}`, updatedUser);
      return updatedUser;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update user with ID ${id}`,
        'update',
        error
      );
    }
  },

  /**
   * Delete a user
   */
  async delete(id: string) {
    try {
      const changeManager = SyncChangeManager.getInstance();
      let userId: string = id;

      await db.transaction('rw', [db.users, db.localChanges], async () => {
        const deletedUser = await db.users.get(id);
        if (!deletedUser) {
          console.log(`User with ID ${id} not found for deletion, likely already deleted.`);
          return;
        }
        userId = deletedUser.id;

        await db.users.delete(id);
        await changeManager.trackChange(
          'users',
          'delete',
          { id: userId } as unknown as Record<string, unknown>
        );
      });

      console.log(`User deleted: ${userId}`);
      return { id: userId, deleted: true };
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete user with ID ${id}`,
        'delete',
        error
      );
    }
  }
};

/**
 * Project service for project-related operations
 */
export const ProjectService = {
  /**
   * Get a project by ID
   */
  async getById(id: string) {
    try {
      return await db.projects.get(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get project with ID ${id}`,
        'getById',
        error
      );
    }
  },

  /**
   * Get all projects
   */
  async getAll() {
    try {
      return await db.projects.toArray();
    } catch (error) {
      throw new DatabaseServiceError(
        'Failed to get all projects',
        'getAll',
        error
      );
    }
  },

  /**
   * Create a new project
   */
  async create(project: Partial<DbProject> & { name: string }) {
    try {
      const now = new Date();
      const projectId = project.id || uuidv4();
      const changeManager = SyncChangeManager.getInstance();
      const clientId = changeManager.getClientId();

      const newProject = {
        id: projectId,
        name: project.name,
        description: project.description || '',
        ownerId: project.ownerId || null, // Allow owner to be optional for now
        status: project.status || 'active', // Assuming a default status
        createdAt: now,
        updatedAt: now
      } as DbProject;

      await db.transaction('rw', [db.projects, db.localChanges], async () => {
        await db.projects.add(newProject);
        await changeManager.trackChange(
          'projects',
          'insert',
          newProject as unknown as Record<string, unknown>
        );
      });

      console.log(`Project created: ${projectId}`, newProject);
      return newProject;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create project "${project.name}"`,
        'create',
        error
      );
    }
  },

  /**
   * Update an existing project
   */
  async update(id: string, changes: Partial<DbProject>) {
    try {
      const now = new Date();
      let updatedProject: DbProject | null = null;
      const changeManager = SyncChangeManager.getInstance();
      const clientId = changeManager.getClientId();

      await db.transaction('rw', [db.projects, db.localChanges], async () => {
        const project = await db.projects.get(id);
        if (!project) {
          throw new Error(`Project with ID ${id} not found`);
        }

        // Create updated project object
        updatedProject = {
          ...project,
          ...changes,
          updatedAt: now
        };

        // Update the project in the database
        await db.projects.update(id, { ...changes, updatedAt: now });

        await changeManager.trackChange(
          'projects',
          'update',
          updatedProject as unknown as Record<string, unknown>
        );
      });

      if (!updatedProject) {
        throw new Error(`Failed to update project with ID ${id}`);
      }

      console.log(`Project updated: ${id}`, updatedProject);
      return updatedProject;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update project with ID ${id}`,
        'update',
        error
      );
    }
  },

  /**
   * Delete a project
   */
  async delete(id: string) {
    try {
      const changeManager = SyncChangeManager.getInstance();
      let projectId: string = id;

      await db.transaction('rw', [db.projects, db.localChanges], async () => {
        const deletedProject = await db.projects.get(id);
        if (!deletedProject) {
          // If already deleted, maybe just log and exit gracefully in a debug context?
          console.log(`Project with ID ${id} not found for deletion, likely already deleted.`);
          return; 
          // Or throw: throw new Error(`Project with ID ${id} not found`);
        }
        projectId = deletedProject.id;

        await db.projects.delete(id);
        await changeManager.trackChange(
          'projects',
          'delete',
          { id: projectId } as unknown as Record<string, unknown>
        );
      });

      console.log(`Project deleted: ${projectId}`);
      return { id: projectId, deleted: true };
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete project with ID ${id}`,
        'delete',
        error
      );
    }
  }
};

/**
 * Task service for task-related operations
 * Now with integrated sync change tracking
 */
export const TaskService = {
  /**
   * Create a new task
   */
  async create(task: Partial<DbTask> & { title: string; projectId: string }) {
    try {
      const now = new Date();
      const taskId = task.id || uuidv4();
      
      // Get instance of SyncChangeManager
      const changeManager = SyncChangeManager.getInstance();
      
      // Get current client ID for change tracking
      const clientId = changeManager.getClientId();
      
      // Create task object with defaults
      const newTask = {
        id: taskId,
        title: task.title,
        description: task.description || '',
        status: task.status || TaskStatus.OPEN,
        priority: task.priority || TaskPriority.MEDIUM,
        projectId: task.projectId,
        assigneeId: task.assigneeId || null,
        dueDate: task.dueDate || null,
        timeRange: task.timeRange || null,
        estimatedDuration: task.estimatedDuration || null,
        completedAt: undefined,
        tags: task.tags || [],
        createdAt: now,
        updatedAt: now
      } as DbTask;

      // Create transaction for atomicity
      await db.transaction('rw', [db.tasks, db.localChanges], async () => {
        // Add the task to the database
        await db.tasks.add(newTask);
        
        // Track the change using the SyncChangeManager
        await changeManager.trackChange(
          'tasks',
          'insert', 
          newTask as unknown as Record<string, unknown>
        );
      });
      
      console.log(`Task created: ${taskId}`, newTask);
      return newTask;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create task "${task.title}"`,
        'create',
        error
      );
    }
  },

  /**
   * Update an existing task
   */
  async update(id: string, changes: Partial<DbTask>) {
    try {
      const now = new Date();
      let updatedTask: DbTask | null = null;
      
      // Get instance of SyncChangeManager
      const changeManager = SyncChangeManager.getInstance();
      
      // Get current client ID for change tracking
      const clientId = changeManager.getClientId();
      
      // Create transaction for atomicity
      await db.transaction('rw', [db.tasks, db.localChanges], async () => {
        // Ensure the task exists
        const task = await db.tasks.get(id);
        if (!task) {
          throw new Error(`Task with ID ${id} not found`);
        }

        // Create updated task object - set client_id to mark our ownership
        updatedTask = {
          ...task,
          ...changes,
          updatedAt: now
        };

        // Update the task in the database - use changes object directly
        await db.tasks.update(id, changes);
        
        // Track the change using the SyncChangeManager
        await changeManager.trackChange(
          'tasks',
          'update',
          updatedTask as unknown as Record<string, unknown>
        );
      });
      
      if (!updatedTask) {
        throw new Error(`Failed to update task with ID ${id}`);
      }
      
      console.log(`Task updated: ${id}`, updatedTask);
      return updatedTask;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update task with ID ${id}`,
        'update',
        error
      );
    }
  },

  /**
   * Delete a task
   */
  async delete(id: string) {
    try {
      const now = new Date();
      let taskId: string = id;
      
      // Get instance of SyncChangeManager
      const changeManager = SyncChangeManager.getInstance();
      
      // Create transaction for atomicity
      await db.transaction('rw', [db.tasks, db.localChanges], async () => {
        // Ensure the task exists and get its data for the change record
        const deletedTask = await db.tasks.get(id);
        if (!deletedTask) {
          throw new Error(`Task with ID ${id} not found`);
        }
        
        // Save the task ID
        taskId = deletedTask.id;

        // Delete the task from the database
        await db.tasks.delete(id);
        
        // Track the change using the SyncChangeManager
        await changeManager.trackChange(
          'tasks',
          'delete',
          { id: taskId } as unknown as Record<string, unknown>
        );
      });
      
      console.log(`Task deleted: ${taskId}`);
      return { id: taskId, deleted: true };
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete task with ID ${id}`,
        'delete',
        error
      );
    }
  },

  /**
   * Update a task's status
   */
  async updateStatus(id: string, status: TaskStatus) {
    // This is a specific type of update that only changes the status
    // and optionally the completedAt date for completed tasks
    const changes: Partial<DbTask> = {
      status
    };
    
    // Add completedAt date if marking as completed
    if (status === TaskStatus.COMPLETED) {
      changes.completedAt = new Date();
    } else {
      // Clear completedAt if moving out of completed status
      changes.completedAt = undefined;
    }
    
    // Use the regular update method
    return this.update(id, changes);
  },

  /**
   * Get a task by ID
   */
  async getById(id: string) {
    try {
      return await db.tasks.get(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get task with ID ${id}`,
        'getById',
        error
      );
    }
  },

  /**
   * Get all tasks
   */
  async getAll() {
    try {
      return await db.tasks.toArray();
    } catch (error) {
      throw new DatabaseServiceError(
        'Failed to get all tasks',
        'getAll',
        error
      );
    }
  },

  /**
   * Get tasks by project
   */
  async getByProject(projectId: string) {
    try {
      return await db.tasks
        .where('projectId')
        .equals(projectId)
        .toArray();
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get tasks for project with ID ${projectId}`,
        'getByProject',
        error
      );
    }
  },

  /**
   * Get tasks by assignee
   */
  async getByAssignee(assigneeId: string) {
    try {
      return await db.tasks
        .where('assigneeId')
        .equals(assigneeId)
        .toArray();
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get tasks for assignee with ID ${assigneeId}`,
        'getByAssignee',
        error
      );
    }
  }
};

/**
 * Comment service for comment-related operations
 */
export const CommentService = {
  /**
   * Add a comment to a task
   */
  async addToTask(taskId: string, authorId: string, content: string) {
    try {
      const now = new Date();
      const commentId = uuidv4();
      const changeManager = SyncChangeManager.getInstance();
      const clientId = changeManager.getClientId();
      
      const newComment = {
        id: commentId,
        content: content,
        entityId: taskId, // Link to task
        entityType: 'task', // Specify entity type
        authorId: authorId,
        parentId: undefined, // Use undefined instead of null for optional string
        createdAt: now,
        updatedAt: now
      } as DbComment;

      await db.transaction('rw', [db.comments, db.localChanges], async () => {
        await db.comments.add(newComment);
        await changeManager.trackChange(
          'comments',
          'insert',
          newComment as unknown as Record<string, unknown>
        );
      });

      console.log(`Comment added to task ${taskId}: ${commentId}`, newComment);
      return newComment;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to add comment to task ${taskId}`,
        'addToTask',
        error
      );
    }
  },

  /**
   * Get comments for a task
   */
  async getForTask(taskId: string) {
    try {
      // Use the compound index for efficiency
      return await db.comments
        .where('[entityType+entityId]')
        .equals(['task', taskId])
        .sortBy('createdAt');
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get comments for task ${taskId}`,
        'getForTask',
        error
      );
    }
  },
  
  /**
   * Update an existing comment
   */
  async update(id: string, changes: Partial<DbComment>) {
    try {
      const now = new Date();
      let updatedComment: DbComment | null = null;
      const changeManager = SyncChangeManager.getInstance();
      const clientId = changeManager.getClientId();

      await db.transaction('rw', [db.comments, db.localChanges], async () => {
        const comment = await db.comments.get(id);
        if (!comment) {
          throw new Error(`Comment with ID ${id} not found`);
        }

        // Create updated comment object
        updatedComment = {
          ...comment,
          ...changes,
          updatedAt: now
        };
        
        // Prepare changes for Dexie update (only send actual changes + tracking fields)
        const updateData = { ...changes, updatedAt: now };

        // Update the comment in the database
        await db.comments.update(id, updateData);

        await changeManager.trackChange(
          'comments',
          'update',
          updatedComment as unknown as Record<string, unknown>
        );
      });

      if (!updatedComment) {
        throw new Error(`Failed to update comment with ID ${id}`);
      }

      console.log(`Comment updated: ${id}`, updatedComment);
      return updatedComment;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update comment with ID ${id}`,
        'update',
        error
      );
    }
  },

  /**
   * Delete a comment
   */
  async delete(id: string) {
    try {
      const changeManager = SyncChangeManager.getInstance();
      let commentId: string = id;

      await db.transaction('rw', [db.comments, db.localChanges], async () => {
        const deletedComment = await db.comments.get(id);
        if (!deletedComment) {
          console.log(`Comment with ID ${id} not found for deletion, likely already deleted.`);
          return; 
        }
        commentId = deletedComment.id;

        await db.comments.delete(id);
        await changeManager.trackChange(
          'comments',
          'delete',
          { id: commentId } as unknown as Record<string, unknown>
        );
      });

      console.log(`Comment deleted: ${commentId}`);
      return { id: commentId, deleted: true };
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete comment with ID ${id}`,
        'delete',
        error
      );
    }
  }
}; 
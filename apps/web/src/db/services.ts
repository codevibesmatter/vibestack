import { v4 as uuidv4 } from 'uuid';
import { OutgoingChangeProcessor } from '../sync/OutgoingChangeProcessor';
import { DeepPartial } from 'typeorm';
import { User, Project, Task, Comment, TaskStatus, TaskPriority } from '@repo/dataforge/client-entities';
import { UserRepository, ProjectRepository, TaskRepository, CommentRepository } from './repositories';

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
 * Base service with common CRUD operations
 */
abstract class BaseService<T extends object> {
  constructor(
    protected repository: any,
    protected tableName: string,
    protected syncChangeManager: OutgoingChangeProcessor
  ) {}

  // UI-initiated operations (track changes)
  
  async getAll(): Promise<T[]> {
    try {
      return await this.repository.findAll();
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get all ${this.tableName}`,
        'getAll',
        error
      );
    }
  }
  
  // Sync-initiated operations (don't track changes)
  
  async createFromSync(data: DeepPartial<T>): Promise<T> {
    try {
      return await this.repository.create(data);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create ${this.tableName} from sync`,
        'createFromSync',
        error
      );
    }
  }

  async updateFromSync(id: string, data: DeepPartial<T>): Promise<T> {
    try {
      console.log(`[${this.tableName.toUpperCase()}_SERVICE] Attempting to update from sync. ID: ${id}, Data:`,
        JSON.stringify(data, null, 2));
      return await this.repository.update(id, data);
    } catch (error) {
      console.error(`[${this.tableName.toUpperCase()}_SERVICE] Failed to update ${this.tableName} from sync. ID: ${id}`);
      console.error(`[${this.tableName.toUpperCase()}_SERVICE] Error details:`,
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error));
      console.error(`[${this.tableName.toUpperCase()}_SERVICE] Data that failed:`, JSON.stringify(data, null, 2));
      
      // If it's a TypeORM error, try to extract more details
      if (error && typeof error === 'object' && 'name' in error && error.name === 'QueryFailedError') {
        const queryError = error as any; // TypeORM QueryFailedError
        console.error(`[${this.tableName.toUpperCase()}_SERVICE] SQL Error:`, {
          query: queryError.query,
          parameters: queryError.parameters,
          driverError: queryError.driverError
        });
      }
      
      throw new DatabaseServiceError(
        `Failed to update ${this.tableName} from sync`,
        'updateFromSync',
        error
      );
    }
  }

  async deleteFromSync(id: string): Promise<boolean> {
    try {
      return await this.repository.delete(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete ${this.tableName} from sync`,
        'deleteFromSync',
        error
      );
    }
  }
public getRepo(): any { // Or a more specific Repository base type
    return this.repository;
  }
}

/**
 * User service
 */
export class UserService extends BaseService<User> {
  constructor(
    protected userRepository: UserRepository,
    protected syncChangeManager: OutgoingChangeProcessor
  ) {
    super(userRepository, 'users', syncChangeManager);
  }

  async get(id: string): Promise<User | null> {
    try {
      return await this.repository.findById(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get user with ID ${id}`,
        'get',
        error
      );
    }
  }

  async createUser(userData: { name: string; email: string }): Promise<User> {
    try {
      const now = new Date();
      const userId = uuidv4();
      
      const newUser = {
        id: userId,
        name: userData.name,
        email: userData.email,
        createdAt: now,
        updatedAt: now
      } as User;

      const createdUser = await this.repository.create(newUser);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'insert',
        createdUser as unknown as Record<string, unknown>
      );
      
      return createdUser;
    } catch (error) {
      throw new DatabaseServiceError(
        'Failed to create user',
        'createUser',
        error
      );
    }
  }

  async updateUser(id: string, changes: Partial<User>): Promise<User> {
    try {
      const user = await this.repository.findById(id);
      if (!user) {
        throw new Error(`User with ID ${id} not found`);
      }
      
      const updatedData = {
        ...changes,
        updatedAt: new Date()
      } as DeepPartial<User>;
      
      const updatedUser = await this.repository.update(id, updatedData);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'update',
        updatedUser as unknown as Record<string, unknown>
      );
      
      return updatedUser;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update user with ID ${id}`,
        'updateUser',
        error
      );
    }
  }

  async deleteUser(id: string): Promise<boolean> {
    try {
      const user = await this.repository.findById(id);
      if (!user) {
        throw new Error(`User with ID ${id} not found`);
      }
      
      const success = await this.repository.delete(id);
      
      // Track change for sync
      if (success) {
        await this.syncChangeManager.trackChange(
          this.tableName,
          'delete',
          { id } as unknown as Record<string, unknown>
        );
      }
      
      return success;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete user with ID ${id}`,
        'deleteUser',
        error
      );
    }
  }
}

/**
 * Project service
 */
export class ProjectService extends BaseService<Project> {
  constructor(
    protected projectRepository: ProjectRepository,
    protected syncChangeManager: OutgoingChangeProcessor
  ) {
    super(projectRepository, 'projects', syncChangeManager);
  }

  async get(id: string): Promise<Project | null> {
    try {
      return await this.repository.findById(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get project with ID ${id}`,
        'get',
        error
      );
    }
  }

  async createProject(projectData: { name: string; description?: string; ownerId?: string }): Promise<Project> {
    try {
      const now = new Date();
      const projectId = uuidv4();
      
      const newProject = {
        id: projectId,
        name: projectData.name,
        description: projectData.description || '',
        ownerId: projectData.ownerId || null,
        status: 'active', // Default status
        createdAt: now,
        updatedAt: now
      } as Project;

      const createdProject = await this.repository.create(newProject);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'insert',
        createdProject as unknown as Record<string, unknown>
      );
      
      // Dispatch custom event to notify UI of project creation
      const event = new CustomEvent('project-created', { 
        detail: { project: createdProject } 
      });
      window.dispatchEvent(event);
      console.log('[ProjectService] Dispatched project-created event');
      
      return createdProject;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create project "${projectData.name}"`,
        'createProject',
        error
      );
    }
  }

  async updateProject(id: string, changes: Partial<Project>): Promise<Project> {
    try {
      const project = await this.repository.findById(id);
      if (!project) {
        throw new Error(`Project with ID ${id} not found`);
      }
      
      const updatedData = {
        ...changes,
        updatedAt: new Date()
      } as DeepPartial<Project>;
      
      const updatedProject = await this.repository.update(id, updatedData);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'update',
        updatedProject as unknown as Record<string, unknown>
      );
      
      // Dispatch custom event to notify UI of project update
      const event = new CustomEvent('project-updated', { 
        detail: { project: updatedProject } 
      });
      window.dispatchEvent(event);
      console.log('[ProjectService] Dispatched project-updated event');
      
      return updatedProject;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update project with ID ${id}`,
        'updateProject',
        error
      );
    }
  }

  async deleteProject(id: string): Promise<boolean> {
    try {
      const project = await this.repository.findById(id);
      if (!project) {
        throw new Error(`Project with ID ${id} not found`);
      }
      
      const success = await this.repository.delete(id);
      
      // Track change for sync
      if (success) {
        await this.syncChangeManager.trackChange(
          this.tableName,
          'delete',
          { id } as unknown as Record<string, unknown>
        );
        
        // Dispatch custom event to notify UI of project deletion
        const event = new CustomEvent('project-deleted', { 
          detail: { projectId: id } 
        });
        window.dispatchEvent(event);
        console.log('[ProjectService] Dispatched project-deleted event');
      }
      
      return success;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete project with ID ${id}`,
        'deleteProject',
        error
      );
    }
  }
}

/**
 * Task service
 */
export class TaskService extends BaseService<Task> {
  constructor(
    protected taskRepository: TaskRepository,
    protected syncChangeManager: OutgoingChangeProcessor
  ) {
    super(taskRepository, 'tasks', syncChangeManager);
  }

  async get(id: string): Promise<Task | null> {
    try {
      return await this.repository.findById(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get task with ID ${id}`,
        'get',
        error
      );
    }
  }

  async getByProject(projectId: string): Promise<Task[]> {
    try {
      return await this.repository.findByProject(projectId);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get tasks for project with ID ${projectId}`,
        'getByProject',
        error
      );
    }
  }

  async getByAssignee(assigneeId: string): Promise<Task[]> {
    try {
      return await this.repository.findByAssignee(assigneeId);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get tasks for assignee with ID ${assigneeId}`,
        'getByAssignee',
        error
      );
    }
  }

  async createTask(taskData: {
    title: string;
    projectId: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeId?: string;
    dueDate?: Date;
    timeRange?: [Date, Date];
    estimatedDuration?: number;
    tags?: string[];
  }): Promise<Task> {
    try {
      const now = new Date();
      const taskId = uuidv4();
      
      const newTask = {
        id: taskId,
        title: taskData.title,
        projectId: taskData.projectId,
        description: taskData.description || '',
        status: taskData.status || TaskStatus.OPEN,
        priority: taskData.priority || TaskPriority.MEDIUM,
        assigneeId: taskData.assigneeId || null,
        dueDate: taskData.dueDate || null,
        startDate: taskData.timeRange?.[0] || null,
        endDate: taskData.timeRange?.[1] || null,
        estimatedDuration: taskData.estimatedDuration || null,
        tags: Array.isArray(taskData.tags) ? taskData.tags : [],
        createdAt: now,
        updatedAt: now
      } as unknown as Task;

      const createdTask = await this.repository.create(newTask);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'insert',
        createdTask as unknown as Record<string, unknown>
      );
      
      // Dispatch custom event to notify UI of task creation
      const event = new CustomEvent('task-created', { 
        detail: { task: createdTask } 
      });
      window.dispatchEvent(event);
      console.log('[TaskService] Dispatched task-created event');
      
      return createdTask;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create task "${taskData.title}"`,
        'createTask',
        error
      );
    }
  }

  async updateTask(id: string, changes: Partial<Task>): Promise<Task> {
    try {
      const task = await this.repository.findById(id);
      if (!task) {
        throw new Error(`Task with ID ${id} not found`);
      }
      
      const updatedData = {
        ...changes,
        updatedAt: new Date()
      } as DeepPartial<Task>;
      
      const updatedTask = await this.repository.update(id, updatedData);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'update',
        updatedTask as unknown as Record<string, unknown>
      );
      
      // Dispatch custom event to notify UI of task update
      const event = new CustomEvent('task-updated', { 
        detail: { task: updatedTask } 
      });
      window.dispatchEvent(event);
      console.log('[TaskService] Dispatched task-updated event');
      
      return updatedTask;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update task with ID ${id}`,
        'updateTask',
        error
      );
    }
  }

  async deleteTask(id: string): Promise<boolean> {
    try {
      const task = await this.repository.findById(id);
      if (!task) {
        throw new Error(`Task with ID ${id} not found`);
      }
      
      const success = await this.repository.delete(id);
      
      // Track change for sync
      if (success) {
        await this.syncChangeManager.trackChange(
          this.tableName,
          'delete',
          { id } as unknown as Record<string, unknown>
        );
        
        // Dispatch custom event to notify UI of task deletion
        const event = new CustomEvent('task-deleted', { 
          detail: { taskId: id } 
        });
        window.dispatchEvent(event);
        console.log('[TaskService] Dispatched task-deleted event');
      }
      
      return success;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete task with ID ${id}`,
        'deleteTask',
        error
      );
    }
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    try {
      const task = await this.repository.findById(id);
      if (!task) {
        throw new Error(`Task with ID ${id} not found`);
      }
      
      const updatedTask = await this.repository.update(id, { 
        status,
        updatedAt: new Date()
      } as DeepPartial<Task>);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'update',
        updatedTask as unknown as Record<string, unknown>
      );
      
      // Dispatch custom event to notify UI of task status update
      const event = new CustomEvent('task-updated', { 
        detail: { task: updatedTask, statusChanged: true } 
      });
      window.dispatchEvent(event);
      console.log('[TaskService] Dispatched task-updated event (status change)');
      
      return updatedTask;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update status for task with ID ${id}`,
        'updateTaskStatus',
        error
      );
    }
  }
}

/**
 * Comment service
 */
export class CommentService extends BaseService<Comment> {
  constructor(
    protected commentRepository: CommentRepository,
    protected syncChangeManager: OutgoingChangeProcessor
  ) {
    super(commentRepository, 'comments', syncChangeManager);
  }

  async get(id: string): Promise<Comment | null> {
    try {
      return await this.repository.findById(id);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get comment with ID ${id}`,
        'get',
        error
      );
    }
  }

  async getByTask(taskId: string): Promise<Comment[]> {
    try {
      return await this.repository.findByTask(taskId);
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to get comments for task with ID ${taskId}`,
        'getByTask',
        error
      );
    }
  }

  async createComment(commentData: {
    content: string;
    taskId: string;
    authorId: string;
    parentId?: string;
  }): Promise<Comment> {
    try {
      const now = new Date();
      const commentId = uuidv4();
      
      const newComment = {
        id: commentId,
        content: commentData.content,
        taskId: commentData.taskId,
        authorId: commentData.authorId,
        parentId: commentData.parentId || null,
        createdAt: now,
        updatedAt: now
      } as Comment;

      const createdComment = await this.repository.create(newComment);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'insert',
        createdComment as unknown as Record<string, unknown>
      );
      
      return createdComment;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to create comment for task ${commentData.taskId}`,
        'createComment',
        error
      );
    }
  }

  async updateComment(id: string, changes: Partial<Comment>): Promise<Comment> {
    try {
      const comment = await this.repository.findById(id);
      if (!comment) {
        throw new Error(`Comment with ID ${id} not found`);
      }
      
      const updatedData = {
        ...changes,
        updatedAt: new Date()
      } as DeepPartial<Comment>;
      
      const updatedComment = await this.repository.update(id, updatedData);
      
      // Track change for sync
      await this.syncChangeManager.trackChange(
        this.tableName,
        'update',
        updatedComment as unknown as Record<string, unknown>
      );
      
      return updatedComment;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to update comment with ID ${id}`,
        'updateComment',
        error
      );
    }
  }

  async deleteComment(id: string): Promise<boolean> {
    try {
      const comment = await this.repository.findById(id);
      if (!comment) {
        throw new Error(`Comment with ID ${id} not found`);
      }
      
      const success = await this.repository.delete(id);
      
      // Track change for sync
      if (success) {
        await this.syncChangeManager.trackChange(
          this.tableName,
          'delete',
          { id } as unknown as Record<string, unknown>
        );
      }
      
      return success;
    } catch (error) {
      throw new DatabaseServiceError(
        `Failed to delete comment with ID ${id}`,
        'deleteComment',
        error
      );
    }
  }
}

/**
 * Factory function to create all services
 */
export function createServices(
  repositories: {
    users: UserRepository;
    projects: ProjectRepository;
    tasks: TaskRepository;
    comments: CommentRepository;
  },
  syncChangeManager: OutgoingChangeProcessor
) {
  return {
    users: new UserService(repositories.users, syncChangeManager),
    projects: new ProjectService(repositories.projects, syncChangeManager),
    tasks: new TaskService(repositories.tasks, syncChangeManager),
    comments: new CommentService(repositories.comments, syncChangeManager)
  };
} 
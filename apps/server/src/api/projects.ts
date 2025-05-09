import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception'; // Import HTTPException
import {
  type ApiEnv,
  ServiceErrorType,
  createSuccessResponse,
  createErrorResponse
} from '../types/api';
import { NeonService } from '../lib/neon-orm/neon-service';
import { Project, ProjectStatus } from "@repo/dataforge/server-entities";
import { ProjectRepository } from '../domains/projects';

// Re-export enums for convenience
export { ProjectStatus };

// Input types for API
export type ProjectCreateInput = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;
export type ProjectUpdateInput = Partial<ProjectCreateInput>;

// Create projects router
const projects = new Hono<ApiEnv>();

// List projects
projects.get('/', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const neonService = new NeonService(c);
    const projectRepo = new ProjectRepository(neonService);
    const { status } = c.req.query();

    let result: Project[];
    if (status && Object.values(ProjectStatus).includes(status as ProjectStatus)) {
      // Use repository for status filtering
      result = await projectRepo.findByStatus(status as ProjectStatus);
    } else {
      // Use repository for all projects
      result = await projectRepo.findAll();
    }

    return c.json(createSuccessResponse(result));
  } catch (err) {
    console.error('Error listing projects:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Create project
projects.post('/', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const projectRepo = new ProjectRepository(neonService);

    // The repository will handle defaults and validation
    const result = await projectRepo.create(body);

    return c.json(createSuccessResponse(result), 201);
  } catch (err) {
    console.error('Error creating project:', err);
    if (err instanceof Error && err.message.includes('validation')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Get project by ID
projects.get('/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const projectRepo = new ProjectRepository(neonService);

    const project = await projectRepo.findById(id);

    if (!project) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found`
        ),
        404
      );
    }

    return c.json(createSuccessResponse(project));
  } catch (err) {
    console.error('Error getting project:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Update project
projects.patch('/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const neonService = new NeonService(c);
    const projectRepo = new ProjectRepository(neonService);

    // Find the project first to ensure it exists
    const existingProject = await projectRepo.findById(id);
    if (!existingProject) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found`
        ),
        404
      );
    }

    // Update the project with the provided data
    await projectRepo.update(id, body);

    // Always fetch the updated project to return the most recent state
    const updatedProject = await projectRepo.findById(id);
    if (!updatedProject) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found after update`
        ),
        404
      );
    }

    return c.json(createSuccessResponse(updatedProject));
  } catch (err) {
    console.error('Error updating project:', err);
    if (err instanceof Error && err.message.includes('validation')) {
      return c.json(
        createErrorResponse(ServiceErrorType.VALIDATION, err.message),
        400
      );
    }
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

// Delete project
projects.delete('/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  try {
    const id = c.req.param('id');
    const neonService = new NeonService(c);
    const projectRepo = new ProjectRepository(neonService);

    // Find the project first to ensure it exists
    const existingProject = await projectRepo.findById(id);
    if (!existingProject) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} not found`
        ),
        404
      );
    }

    // Delete the project
    const deleted = await projectRepo.delete(id);

    if (!deleted) {
      return c.json(
        createErrorResponse(
          ServiceErrorType.NOT_FOUND,
          `Project with id ${id} could not be deleted`
        ),
        500
      );
    }

    return c.json(createSuccessResponse({ id }));
  } catch (err) {
    console.error('Error deleting project:', err);
    return c.json(
      createErrorResponse(ServiceErrorType.INTERNAL, String(err)),
      500
    );
  }
});

export { projects };
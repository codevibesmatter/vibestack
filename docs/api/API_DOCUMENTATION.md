# API Documentation

This document describes the HTTP API endpoints currently implemented for our TinyBase project. The API is built on Hono and interacts with a Cloudflare Durable Object through an RPC mechanism.

## Overview

Our HTTP API provides RESTful endpoints for managing projects, users, and tasks. The API uses a consistent response format and error handling across all endpoints.

### Response Format

All API responses follow this structure:
```typescript
interface ServiceResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    type: ServiceErrorType;
    message: string;
    details?: unknown;
  };
}
```

### Error Types
The API uses standardized error types:
- `NOT_FOUND`: Resource not found (404)
- `VALIDATION`: Invalid input data (400)
- `PERMISSION`: Unauthorized access (403)
- `CONFLICT`: Resource conflict (409)
- `INTERNAL`: Server error (500)

## Endpoints

### Projects

#### GET `/api/v1/projects`
- **Description**: Retrieves a paginated list of projects
- **Query Parameters**:
  - `page`: Page number (optional)
  - `limit`: Items per page (optional)
  - `sort`: Sort field (optional)
  - `order`: Sort order ('asc' or 'desc', optional)
- **Response**:
  ```typescript
  {
    ok: true,
    data: {
      rows: Record<string, ProjectData>;
      total: number;
      hasMore: boolean;
    }
  }
  ```

#### POST `/api/v1/projects`
- **Description**: Creates a new project
- **Request Body**: Project data (validated using zod)
- **Response**:
  ```typescript
  {
    ok: true,
    data: {
      id: string;
    }
  }
  ```

#### GET `/api/v1/projects/:id`
- **Description**: Retrieves a specific project by ID
- **Response**:
  ```typescript
  {
    ok: true,
    data: ProjectData
  }
  ```
- **Error Response** (if not found):
  ```typescript
  {
    ok: false,
    error: {
      type: "NOT_FOUND",
      message: "Project {id} not found"
    }
  }
  ```

#### PUT `/api/v1/projects/:id`
- **Description**: Updates an existing project
- **Request Body**: Project data (validated using zod)
- **Response**:
  ```typescript
  {
    ok: true,
    data: {
      id: string;
    }
  }
  ```

#### DELETE `/api/v1/projects/:id`
- **Description**: Deletes a project
- **Response**:
  ```typescript
  {
    ok: true,
    data: {
      id: string;
    }
  }
  ```

### Users

#### GET `/api/v1/users`
- **Description**: Retrieves a paginated list of users
- **Query Parameters**: Same as projects endpoint
- **Response**:
  ```typescript
  {
    ok: true,
    data: {
      rows: Record<string, UserData>;
      total: number;
      hasMore: boolean;
    }
  }
  ```

#### POST `/api/v1/users`
- **Description**: Creates a new user
- **Request Body**: User data (validated using zod)
- **Response**: Same as projects POST

#### GET `/api/v1/users/:id`
- **Description**: Retrieves a specific user by ID
- **Response**: Same format as projects GET

#### PUT `/api/v1/users/:id`
- **Description**: Updates an existing user
- **Request Body**: User data (validated using zod)
- **Response**: Same as projects PUT

#### DELETE `/api/v1/users/:id`
- **Description**: Deletes a user
- **Response**: Same as projects DELETE

### Tasks

#### GET `/api/v1/tasks`
- **Description**: Retrieves a paginated list of tasks
- **Query Parameters**: Same as projects endpoint
- **Response**:
  ```typescript
  {
    ok: true,
    data: {
      rows: Record<string, TaskData>;
      total: number;
      hasMore: boolean;
    }
  }
  ```

#### POST `/api/v1/tasks`
- **Description**: Creates a new task
- **Request Body**: Task data (validated using zod)
- **Additional Fields**:
  - `status`: Defaults to 'pending' if not provided
- **Response**: Same as projects POST

#### GET `/api/v1/tasks/:id`
- **Description**: Retrieves a specific task by ID
- **Response**: Same format as projects GET

#### PUT `/api/v1/tasks/:id`
- **Description**: Updates an existing task
- **Request Body**: Task data (validated using zod)
- **Response**: Same as projects PUT

#### DELETE `/api/v1/tasks/:id`
- **Description**: Deletes a task
- **Response**: Same as projects DELETE

## Implementation Details

### Middleware

The API implements several middleware components:
1. **CORS**: Handles Cross-Origin Resource Sharing
2. **Logger**: Provides request/response logging
3. **Tinybase**: Injects the store instance into the request context

### Data Storage

Data is stored in a Cloudflare Durable Object, accessed through the `TinybaseOperations` class which provides:
- Table querying with pagination
- Row-level CRUD operations
- Batch operations for setting/deleting multiple rows

### Validation

Input validation is handled using:
- Zod schemas for request body validation
- Hono's zValidator middleware for route-level validation
- Custom validation utilities for row data

## Error Handling

The API implements consistent error handling across all endpoints:
1. Service-level errors are thrown as `ServiceError` instances
2. Errors are caught and transformed into appropriate HTTP responses
3. Status codes are mapped based on error types
4. All errors maintain the consistent response format

## Future Considerations

1. **Authentication/Authorization**: Implement user authentication and role-based access control
2. **Rate Limiting**: Add rate limiting middleware for API protection
3. **API Versioning**: Maintain version compatibility as new features are added
4. **Additional Resources**: Implement endpoints for other domain entities
5. **WebSocket Support**: Add real-time updates for collaborative features

This documentation serves as a living reference and will be updated as the API evolves. 
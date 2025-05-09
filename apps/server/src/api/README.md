# VibeStack API Documentation

This documentation covers the REST API endpoints available in the VibeStack application. All endpoints return JSON responses following a standard format.

## Base URL

All API endpoints are accessible at:

```
http://localhost:8787/api
```

## Response Format

All responses follow a standard format:

### Success Response

```json
{
  "ok": true,
  "data": { ... } // Response data
}
```

### Error Response

```json
{
  "ok": false,
  "error": {
    "type": "ERROR_TYPE",
    "message": "Human readable error message"
  }
}
```

Error types include:
- `VALIDATION` - Invalid input data
- `NOT_FOUND` - Requested resource not found
- `INTERNAL` - Server error
- `UNAUTHORIZED` - Authentication required
- `FORBIDDEN` - Permission denied

## Authentication

Authentication details to be added in future versions.

## API Endpoints

### Tasks

Tasks represent work items within projects.

#### List Tasks

```
GET /api/tasks
```

Query parameters:
- `status` (optional) - Filter by status (open, in_progress, completed)
- `priority` (optional) - Filter by priority (low, medium, high, urgent)
- `projectId` (optional) - Filter by project ID

Example response:

```json
{
  "ok": true,
  "data": [
    {
      "id": "f8e857eb-6b46-4187-8021-c9aa3df28202",
      "title": "Implement API docs",
      "description": "Create comprehensive API documentation",
      "status": "in_progress",
      "priority": "medium",
      "projectId": "533d9e0b-bccc-4029-92d8-a040440fad51",
      "assigneeId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
      "createdAt": "2023-06-14T12:00:00.000Z",
      "updatedAt": "2023-06-15T14:30:00.000Z",
      "completedAt": null
    }
  ]
}
```

#### Get Task

```
GET /api/tasks/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "f8e857eb-6b46-4187-8021-c9aa3df28202",
    "title": "Implement API docs",
    "description": "Create comprehensive API documentation",
    "status": "in_progress",
    "priority": "medium",
    "projectId": "533d9e0b-bccc-4029-92d8-a040440fad51",
    "assigneeId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-15T14:30:00.000Z",
    "completedAt": null
  }
}
```

#### Create Task

```
POST /api/tasks
```

Request body:

```json
{
  "title": "Implement API docs",
  "description": "Create comprehensive API documentation",
  "status": "open",
  "priority": "medium",
  "projectId": "533d9e0b-bccc-4029-92d8-a040440fad51",
  "assigneeId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa"
}
```

All fields are optional except `title`. Default values:
- `status`: "open"
- `priority`: "medium"

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "f8e857eb-6b46-4187-8021-c9aa3df28202",
    "title": "Implement API docs",
    "description": "Create comprehensive API documentation",
    "status": "open",
    "priority": "medium",
    "projectId": "533d9e0b-bccc-4029-92d8-a040440fad51",
    "assigneeId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-14T12:00:00.000Z",
    "completedAt": null
  }
}
```

#### Update Task

```
PATCH /api/tasks/:id
```

Request body (all fields optional):

```json
{
  "title": "Updated title",
  "description": "Updated description",
  "status": "in_progress",
  "priority": "high",
  "assigneeId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa"
}
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "f8e857eb-6b46-4187-8021-c9aa3df28202",
    "title": "Updated title",
    "description": "Updated description",
    "status": "in_progress",
    "priority": "high",
    "projectId": "533d9e0b-bccc-4029-92d8-a040440fad51",
    "assigneeId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-15T14:30:00.000Z",
    "completedAt": null
  }
}
```

Note: When `status` is updated to "completed", the `completedAt` field is automatically set to the current time.

#### Delete Task

```
DELETE /api/tasks/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "f8e857eb-6b46-4187-8021-c9aa3df28202"
  }
}
```

### Projects

Projects are containers for tasks.

#### List Projects

```
GET /api/projects
```

Query parameters:
- `status` (optional) - Filter by status (active, in_progress, completed, on_hold)

Example response:

```json
{
  "ok": true,
  "data": [
    {
      "id": "533d9e0b-bccc-4029-92d8-a040440fad51",
      "name": "API Documentation",
      "description": "Create comprehensive API documentation",
      "status": "active",
      "ownerId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
      "createdAt": "2023-06-01T12:00:00.000Z",
      "updatedAt": "2023-06-01T12:00:00.000Z"
    }
  ]
}
```

#### Get Project

```
GET /api/projects/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "533d9e0b-bccc-4029-92d8-a040440fad51",
    "name": "API Documentation",
    "description": "Create comprehensive API documentation",
    "status": "active",
    "ownerId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "createdAt": "2023-06-01T12:00:00.000Z",
    "updatedAt": "2023-06-01T12:00:00.000Z"
  }
}
```

#### Create Project

```
POST /api/projects
```

Request body:

```json
{
  "name": "API Documentation",
  "description": "Create comprehensive API documentation",
  "status": "active",
  "ownerId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa"
}
```

All fields are optional except `name`. Default values:
- `status`: "active"

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "533d9e0b-bccc-4029-92d8-a040440fad51",
    "name": "API Documentation",
    "description": "Create comprehensive API documentation",
    "status": "active",
    "ownerId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "createdAt": "2023-06-01T12:00:00.000Z",
    "updatedAt": "2023-06-01T12:00:00.000Z"
  }
}
```

#### Update Project

```
PATCH /api/projects/:id
```

Request body (all fields optional):

```json
{
  "name": "Updated name",
  "description": "Updated description",
  "status": "completed"
}
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "533d9e0b-bccc-4029-92d8-a040440fad51",
    "name": "Updated name",
    "description": "Updated description",
    "status": "completed",
    "ownerId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "createdAt": "2023-06-01T12:00:00.000Z",
    "updatedAt": "2023-06-15T14:30:00.000Z"
  }
}
```

#### Delete Project

```
DELETE /api/projects/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "533d9e0b-bccc-4029-92d8-a040440fad51"
  }
}
```

### Users

Users are the people who interact with the application.

#### List Users

```
GET /api/users
```

Query parameters:
- `role` (optional) - Filter by role (admin, member, viewer)

Example response:

```json
{
  "ok": true,
  "data": [
    {
      "id": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
      "name": "Test User",
      "email": "test2@example.com",
      "emailVerified": false,
      "role": "member",
      "image": null,
      "createdAt": "2023-06-14T12:00:00.000Z",
      "updatedAt": "2023-06-14T12:00:00.000Z"
    }
  ]
}
```

#### Get User

```
GET /api/users/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "name": "Test User",
    "email": "test2@example.com",
    "emailVerified": false,
    "role": "member",
    "image": null,
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-14T12:00:00.000Z"
  }
}
```

#### Create User

```
POST /api/users
```

Request body:

```json
{
  "name": "Test User",
  "email": "test2@example.com",
  "role": "member",
  "emailVerified": false,
  "image": "https://example.com/avatar.jpg"
}
```

Required fields: `name` and `email`. Default values:
- `role`: "member"
- `emailVerified`: false

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "name": "Test User",
    "email": "test2@example.com",
    "emailVerified": false,
    "role": "member",
    "image": "https://example.com/avatar.jpg",
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-14T12:00:00.000Z"
  }
}
```

#### Update User

```
PATCH /api/users/:id
```

Request body (all fields optional):

```json
{
  "name": "Updated Name",
  "role": "admin",
  "image": "https://example.com/new-avatar.jpg"
}
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "name": "Updated Name",
    "email": "test2@example.com",
    "emailVerified": false,
    "role": "admin",
    "image": "https://example.com/new-avatar.jpg",
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-15T14:30:00.000Z"
  }
}
```

#### Delete User

```
DELETE /api/users/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa"
  }
}
```

### Comments

Comments can be attached to tasks or projects.

#### List Comments

```
GET /api/comments
```

Query parameters:
- `taskId` (optional) - Filter by task ID
- `projectId` (optional) - Filter by project ID
- `authorId` (optional) - Filter by author ID

Example response:

```json
{
  "ok": true,
  "data": [
    {
      "id": "53fb5b43-94f3-4cdb-a506-d0806a73b914",
      "content": "This is an updated comment",
      "authorId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
      "taskId": "f8e857eb-6b46-4187-8021-c9aa3df28202",
      "projectId": null,
      "parentId": null,
      "createdAt": "2023-06-14T12:00:00.000Z",
      "updatedAt": "2023-06-14T12:15:00.000Z"
    }
  ]
}
```

#### Get Comment

```
GET /api/comments/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "53fb5b43-94f3-4cdb-a506-d0806a73b914",
    "content": "This is an updated comment",
    "authorId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "taskId": "f8e857eb-6b46-4187-8021-c9aa3df28202",
    "projectId": null,
    "parentId": null,
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-14T12:15:00.000Z"
  }
}
```

#### Create Comment

```
POST /api/comments
```

Request body:

```json
{
  "content": "This is a test comment",
  "authorId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
  "taskId": "f8e857eb-6b46-4187-8021-c9aa3df28202",
  "parentId": null
}
```

Required fields: `content`, `authorId`, and either `taskId` or `projectId`. A comment can be attached to a task OR a project, not both.

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "53fb5b43-94f3-4cdb-a506-d0806a73b914",
    "content": "This is a test comment",
    "authorId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "taskId": "f8e857eb-6b46-4187-8021-c9aa3df28202",
    "projectId": null,
    "parentId": null,
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-14T12:00:00.000Z"
  }
}
```

#### Update Comment

```
PATCH /api/comments/:id
```

Request body (all fields optional):

```json
{
  "content": "This is an updated comment"
}
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "53fb5b43-94f3-4cdb-a506-d0806a73b914",
    "content": "This is an updated comment",
    "authorId": "9f8b329f-5ef7-472c-8ecc-24c84c0e13fa",
    "taskId": "f8e857eb-6b46-4187-8021-c9aa3df28202",
    "projectId": null,
    "parentId": null,
    "createdAt": "2023-06-14T12:00:00.000Z",
    "updatedAt": "2023-06-14T12:15:00.000Z"
  }
}
```

#### Delete Comment

```
DELETE /api/comments/:id
```

Example response:

```json
{
  "ok": true,
  "data": {
    "id": "53fb5b43-94f3-4cdb-a506-d0806a73b914"
  }
}
```

## Model Reference

### Task

| Field | Type | Description |
|-------|------|-------------|
| id | string (uuid) | Unique identifier |
| title | string | Task title |
| description | string | Task description |
| status | enum | One of: "open", "in_progress", "completed" |
| priority | enum | One of: "low", "medium", "high", "urgent" |
| projectId | string (uuid) | ID of associated project |
| assigneeId | string (uuid) | ID of assigned user |
| createdAt | datetime | Creation timestamp |
| updatedAt | datetime | Last update timestamp |
| completedAt | datetime | Completion timestamp (null if not completed) |

### Project

| Field | Type | Description |
|-------|------|-------------|
| id | string (uuid) | Unique identifier |
| name | string | Project name |
| description | string | Project description |
| status | enum | One of: "active", "in_progress", "completed", "on_hold" |
| ownerId | string (uuid) | ID of project owner |
| createdAt | datetime | Creation timestamp |
| updatedAt | datetime | Last update timestamp |

### User

| Field | Type | Description |
|-------|------|-------------|
| id | string (uuid) | Unique identifier |
| name | string | User's name |
| email | string | User's email (unique) |
| emailVerified | boolean | Whether email is verified |
| role | enum | One of: "admin", "member", "viewer" |
| image | string | URL to user's avatar image |
| createdAt | datetime | Creation timestamp |
| updatedAt | datetime | Last update timestamp |

### Comment

| Field | Type | Description |
|-------|------|-------------|
| id | string (uuid) | Unique identifier |
| content | string | Comment text content |
| authorId | string (uuid) | ID of comment author |
| taskId | string (uuid) | ID of associated task (null if on project) |
| projectId | string (uuid) | ID of associated project (null if on task) |
| parentId | string (uuid) | ID of parent comment (null if top-level) |
| createdAt | datetime | Creation timestamp |
| updatedAt | datetime | Last update timestamp |

## Status Codes

The API uses the following HTTP status codes:

| Status Code | Description |
|-------------|-------------|
| 200 | OK - Request succeeded |
| 201 | Created - Resource created successfully |
| 400 | Bad Request - Validation error |
| 401 | Unauthorized - Authentication required |
| 403 | Forbidden - Permission denied |
| 404 | Not Found - Resource not found |
| 500 | Internal Server Error - Server error | 
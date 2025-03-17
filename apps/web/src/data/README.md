# Data Layer Architecture

This directory contains the data layer of the application, which is responsible for all data access and manipulation. It is organized into two main parts:

## 1. Data Access Layer (`/access`)

The Data Access Layer provides low-level access to the database with performance tracking and optimized queries.

### Structure

- **Base Classes** (`/access/base`):
  - `DataAccess.ts`: Generic base class for CRUD operations
  - `QueryBuilder.ts`: SQL query builder with fluent interface
  - `ValidatingDataAccess.ts`: Extended DataAccess with automatic entity validation

- **Entity-Specific Implementations** (`/access/entities`):
  - `UserDataAccess.ts`: User-specific data access with optimized queries

### Features

- Performance metrics for all database operations
- Type-safe query building
- Optimized queries with type casting
- Batch operations support
- Automatic entity validation using TypeORM class-validator decorators

## 2. API Layer (`/api`)

The API Layer provides business logic, validation, and a clean interface for entity operations.

### Structure

- `user.ts`: User-specific API functions

### Features

- Data validation
- Business rules enforcement
- Consistent change recording
- Error handling

## 3. Store Layer (`/store`)

The Store Layer provides state management for the application using Jotai atoms.

### Structure

- `users.ts`: User-specific state management
- `projects.ts`: Project-specific state management
- `tasks.ts`: Task-specific state management

### Features

- Reactive state management
- Cached query results
- UI-optimized data structures
- Real-time updates

## Relationship Between Layers

The API layer uses the Data Access layer internally:

```
┌───────────────┐
│  Application  │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Store Layer  │ ← State management, UI data
└───────┬───────┘
        │
        ▼
┌───────────────┐
│   API Layer   │ ← Business logic, validation
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Data Access   │ ← Database operations, query building
└───────┬───────┘
        │
        ▼
┌───────────────┐
│   Database    │
└───────────────┘
```

## Entity Validation

The data layer uses TypeORM's integration with class-validator to provide robust entity validation:

### Validation in Entity Definitions

Entity classes in `@repo/typeorm/src/entities` use class-validator decorators to define validation rules:

```typescript
@Column({ type: "varchar" })
@IsString({ message: "Title must be a string" })
@MinLength(1, { message: "Title cannot be empty" })
@MaxLength(100, { message: "Title cannot exceed 100 characters" })
title!: string;
```

### Automatic Validation in Data Access

The `ValidatingDataAccess` base class automatically validates entities before database operations:

```typescript
export class UserDataAccess extends ValidatingDataAccess<User> {
  constructor() {
    super('user', User);
  }
}
```

### Explicit Validation in API Layer

The API layer can also explicitly validate entities:

```typescript
import { validateEntityOrThrow } from '@repo/typeorm';

export async function createUser(userData: Partial<User>): Promise<string> {
  // Validate user data using class-validator
  await validateEntityOrThrow(userData, User);
  
  // Rest of the function...
}
```

## Usage Examples

### Using the API Layer (Recommended)

```typescript
import { createUser, updateUser, deleteUser } from '../data/api';

// Create a new user
const userId = await createUser({ 
  name: 'John Doe', 
  email: 'john@example.com' 
});

// Update a user
await updateUser(userId, { name: 'John Smith' });

// Delete a user
await deleteUser(userId);
```

### Using the Data Access Layer (Advanced)

```typescript
import { UserDataAccess } from '../data/access';

const userDataAccess = new UserDataAccess();

// Find users with a specific name pattern
const result = await userDataAccess.findByNamePattern('John');
console.log(result.data); // User data
console.log(result.metrics); // Performance metrics
```

### Using the Store Layer (UI Components)

```typescript
import { useAtom } from 'jotai';
import { usersAtom, userByIdAtom } from '../data/store';

// In a React component
function UserList() {
  const [users] = useAtom(usersAtom);
  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}

function UserDetails({ userId }) {
  const [user] = useAtom(userByIdAtom(userId));
  return user ? <div>{user.name} ({user.email})</div> : null;
}
```

## Best Practices

1. **Use the API Layer** for most operations - it handles validation and business logic
2. **Use the Data Access Layer** directly only for advanced queries or performance-critical operations
3. **Use the Store Layer** for UI components - it provides reactive state management
4. **Add new entity types** by creating entity, data access, API, and store implementations
5. **Define validation rules** in entity classes using class-validator decorators
6. **Keep business logic** in the API layer, not in the data access layer
7. **Keep UI logic** in the store layer, not in the API or data access layers 
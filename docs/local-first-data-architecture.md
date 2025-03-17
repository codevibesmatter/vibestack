# Local-First Data Architecture

This document outlines our approach to building a local-first data architecture for web applications, using the SimpleUsersPage as a proof of concept.

## Core Principles

1. **Direct Database Access**: Components query the local database directly when needed
2. **Optimistic UI Updates**: Update the UI immediately, then persist changes asynchronously
3. **Performance Monitoring**: Track and display query and render times
4. **Minimal State Management**: Use React state for UI concerns, database for data persistence

## Proof of Concept: SimpleUsersPage

The SimpleUsersPage demonstrates these principles in action:

### Direct Database Access

```tsx
// Function to fetch users directly from the database
const fetchUsers = async () => {
  try {
    setIsLoading(true);
    setError(null);
    
    if (!db) {
      throw new Error('Database not initialized');
    }
    
    const startTime = performance.now();
    
    const result = await ensureDB(db).query('SELECT * FROM "user" ORDER BY name ASC');
    
    const endTime = performance.now();
    setQueryTime(endTime - startTime);
    
    setUsers(result.rows as UserRow[]);
    console.log(`Query executed in ${endTime - startTime}ms, fetched ${result.rows.length} users`);
  } catch (err) {
    console.error('Error fetching users:', err);
    setError('Failed to load users. Please try again later.');
  } finally {
    setIsLoading(false);
  }
};
```

### Optimistic UI Updates

```tsx
// Handle save edit with optimistic updates
const handleSaveEdit = async () => {
  if (!editingUser) return;
  
  try {
    setIsLoading(true);
    
    // Basic validation
    if (!editName.trim()) {
      alert('Name is required');
      return;
    }
    
    if (!editEmail.trim() || !editEmail.includes('@')) {
      alert('Valid email is required');
      return;
    }
    
    // Create updated user data
    const updatedUser = {
      ...editingUser,
      name: editName,
      email: editEmail,
      updatedAt: new Date().toISOString()
    };
    
    // Record the change in the changes table
    await recordChange('User', editingUser.id, 'update', updatedUser);
    
    // Update local state immediately (optimistic update)
    setUsers(users.map(user => 
      user.id === editingUser.id ? updatedUser : user
    ));
    
    // Close the edit modal
    setIsEditing(false);
    setEditingUser(null);
  } catch (err) {
    console.error('Error updating user:', err);
    alert('Failed to update user. Please try again.');
  } finally {
    setIsLoading(false);
  }
};
```

### Performance Monitoring

```tsx
// Measure render time
useEffect(() => {
  if (isLoading) {
    // Start timing when loading begins
    renderStartTime.current = performance.now();
  } else if (renderStartTime.current !== null) {
    // Calculate render time when loading completes
    const endTime = performance.now();
    const time = endTime - renderStartTime.current;
    setRenderTime(time);
    renderStartTime.current = null;
  }
}, [isLoading]);

// Display performance metrics in the UI
{(queryTime !== null || renderTime !== null) && (
  <div className="mb-4 p-2 bg-gray-800 rounded-lg text-sm text-gray-300">
    <div className="flex space-x-4">
      {queryTime !== null && (
        <div>Query time: <span className="text-green-400">{queryTime.toFixed(2)}ms</span></div>
      )}
      {renderTime !== null && (
        <div>Render time: <span className="text-blue-400">{renderTime.toFixed(2)}ms</span></div>
      )}
      {users.length > 0 && (
        <div>Users loaded: <span className="text-yellow-400">{users.length}</span></div>
      )}
    </div>
  </div>
)}
```

## Current Implementation Evaluation

After reviewing our codebase, we've identified several areas where we can improve:

### Current Architecture

1. **Core Database Layer**:
   - Uses PGlite (SQLite in the browser) with a worker-based architecture
   - Includes initialization, error handling, and termination functionality
   - Provides a message bus for communication between components

2. **Changes Table**:
   - Records changes to entities for later processing
   - Supports insert, update, and delete operations
   - Includes timestamps and processing status

3. **Change Processor**:
   - Periodically processes changes from the changes table
   - Updates the local state (Zustand stores) based on changes
   - Handles errors and retries

4. **Query Layer**:
   - Provides entity-specific query functions (users.ts, projects.ts, tasks.ts)
   - Uses SWR for caching and revalidation
   - Updates Zustand stores with query results

5. **React Hooks**:
   - Provides hooks for database queries and events
   - Supports live queries with automatic updates

### Issues with Current Implementation

1. **Complexity**: The current implementation has multiple layers (message bus, change processor, Zustand stores) that add complexity.

2. **Tight Coupling**: Components like SimpleUsersPage directly use the database and changes table, creating tight coupling.

3. **Duplication**: Similar patterns are repeated across different entity types.

4. **Performance**: The change processor runs on an interval, which may not be optimal for all use cases.

5. **Error Handling**: Error handling is scattered across different components.

## Revised Implementation Plan for a Local-First ERP Architecture

Based on our evaluation, we'll implement thin layers of abstraction that provide the benefits of the current architecture without the complexity. For each implementation step, we'll also identify the code that should be removed or replaced.

### 1. Simplified Data Access Layer

**Goal**: Create a thin data access layer that provides direct database access with performance tracking and optimistic updates.

**Implementation**:
- Create a `DataAccess` class that wraps the database connection
- Include methods for common operations (query, insert, update, delete)
- Add performance tracking to all database operations
- Integrate change recording directly into the data access layer
- Provide type-safe access to entity data

**Code to Remove/Replace**:
- `apps/web/src/db/queries/users.ts`, `projects.ts`, `tasks.ts` - Replace with the new data access layer
- `apps/web/src/db/changes-table.ts` - Integrate into the data access layer
- `apps/web/src/db/change-processor.ts` - Simplify or remove entirely
- `apps/web/src/stores/usersStore.ts`, `projectsStore.ts`, etc. - Replace with direct database access

Example:
```typescript
// Example usage
const userDA = new DataAccess<User>('user');
const users = await userDA.findAll({ orderBy: 'name' });
const user = await userDA.findById(userId);
await userDA.update(userId, { name: 'New Name' });
```

### 2. Entity-Specific Query Builders

**Goal**: Create lightweight query builders for each entity type that provide type-safe access to entity data.

**Implementation**:
- Create a `QueryBuilder` class that generates SQL queries
- Add methods for common operations (select, where, orderBy, limit, offset)
- Support parameterized queries to prevent SQL injection
- Include performance monitoring
- Provide entity-specific query builders for users, projects, tasks, etc.

**Code to Remove/Replace**:
- Raw SQL queries in components (e.g., in `SimpleUsersPage.tsx`)
- Complex query logic in entity-specific query files
- Duplicated query patterns across different entity types

Example:
```typescript
// Example usage
const query = new UserQueryBuilder()
  .where('name', 'LIKE', '%John%')
  .orderBy('createdAt', 'DESC')
  .limit(10);
  
const users = await query.execute();
```

### 3. React Hooks for Data Access

**Goal**: Create React hooks that provide direct access to the database with performance monitoring and optimistic updates.

**Implementation**:
- Create a `useEntity` hook that provides CRUD operations for an entity
- Add support for filtering, sorting, and pagination
- Include performance monitoring
- Support optimistic updates
- Provide entity-specific hooks for users, projects, tasks, etc.

**Code to Remove/Replace**:
- `apps/web/src/db/hooks.ts` - Replace with more focused, entity-specific hooks
- SWR-based hooks in query files (e.g., `useUsersData` in `users.ts`)
- Direct database access in components (e.g., `fetchUsers` in `SimpleUsersPage.tsx`)
- Manual optimistic update logic in components

Example:
```typescript
// Example usage
const { 
  data: users, 
  isLoading, 
  error, 
  create, 
  update, 
  remove 
} = useUsers({ 
  orderBy: 'name' 
});

// Create a new user with optimistic update
await create({ name: 'John', email: 'john@example.com' });

// Update a user with optimistic update
await update(userId, { name: 'New Name' });

// Delete a user with optimistic update
await remove(userId);
```

### 4. Reusable UI Components

**Goal**: Extract reusable UI components from SimpleUsersPage that work with our data access layer.

**Implementation**:
- Create a `DataTable` component that supports sorting, filtering, and pagination
- Add a `EntityForm` component for creating and editing entities
- Include a `PerformanceMonitor` component for displaying performance metrics
- Provide entity-specific components for users, projects, tasks, etc.

**Code to Remove/Replace**:
- Duplicated table logic in different pages
- Inline form components in pages (e.g., the edit modal in `SimpleUsersPage.tsx`)
- Duplicated performance monitoring code
- Repeated UI patterns across different entity types

Example:
```tsx
// Example usage
<DataTable
  data={users}
  columns={userColumns}
  isLoading={isLoading}
  error={error}
  onEdit={handleEdit}
  onDelete={handleDelete}
/>

<EntityForm
  entity={editingUser}
  fields={userFields}
  onSave={handleSave}
  onCancel={handleCancel}
/>

<PerformanceMonitor
  queryTime={queryTime}
  renderTime={renderTime}
  count={users.length}
/>
```

### 5. Simplified Change Recording

**Goal**: Streamline the change recording process by integrating it directly with the data access layer.

**Implementation**:
- Integrate change recording into the data access layer
- Make it transparent to the application code
- Simplify the current complex architecture
- Support offline changes and synchronization

**Code to Remove/Replace**:
- `apps/web/src/db/changes-table.ts` - Integrate into the data access layer
- `apps/web/src/db/change-processor.ts` - Simplify or remove entirely
- Direct calls to `recordChange` in components
- Complex synchronization logic

Example:
```typescript
// Change recording is handled automatically by the data access layer
const userDA = new DataAccess<User>('user');

// Changes are recorded automatically
await userDA.update(userId, { name: 'New Name' });

// Changes can be synchronized when online
await userDA.synchronize();
```

## Implementation Order and Dependency Management

To ensure a smooth transition, we'll implement these abstractions in the following order:

1. **Simplified Data Access Layer** - This is the foundation for all other abstractions
2. **Entity-Specific Query Builders** - Builds on the data access layer
3. **Simplified Change Recording** - Integrates with the data access layer
4. **React Hooks for Data Access** - Uses the data access layer and query builders
5. **Reusable UI Components** - Uses the React hooks for data access

For each step, we'll:
1. Implement the new abstraction
2. Update one entity type (e.g., users) to use the new abstraction
3. Remove the replaced code for that entity type
4. Verify that everything works as expected
5. Repeat for other entity types

## Performance Considerations

Our proof of concept demonstrates excellent performance:

- **Full Page Refresh**: ~100ms query time, ~60ms render time for 100+ users
- **Route Change**: ~50ms query time, ~30ms render time for 100+ users

For larger datasets, consider:

1. **Pagination**: Limit queries to a specific page size
2. **Indexing**: Ensure proper database indexes for common queries
3. **Virtualization**: Use virtualized lists/tables for very large datasets
4. **Chunked Loading**: Load data in chunks as needed

## Conclusion

By implementing these thin layers of abstraction, we can simplify our architecture while maintaining the benefits of a local-first approach:

1. **Simplicity**: Direct database access with minimal abstraction
2. **Performance**: Fast queries with performance monitoring
3. **Optimistic Updates**: Immediate UI updates with background persistence
4. **Offline Support**: Changes are recorded locally and synchronized when online

This approach provides a solid foundation for building complex applications with many data display components while maintaining simplicity and performance. 
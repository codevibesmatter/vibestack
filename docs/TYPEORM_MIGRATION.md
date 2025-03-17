# Migration to TypeORM

## Current System
- LinkML schema definitions in `packages/schema` ✅
- Custom code generation ✅
- Zod validation ✅
- Custom SQL generation ✅
- Separate browser (PGlite) and server (Neon) implementations ✅

## Target System
- TypeORM entities as single source of truth in `packages/db` ✅
- Built-in validation using class-validator ✅
- Split Query Approach:
  - Browser: Direct SQL queries with PGlite + TypeORM migrations/validation ✅
  - Server: Direct SQL queries with @neondatabase/serverless ✅
  - Shared: Entity types and validation ✅
- Automatic schema generation ✅

## Successful Implementation

### Browser-Side Architecture
We successfully implemented a hybrid approach that combines:
1. TypeORM entities for type definitions and validation
2. PGLite for direct SQL queries and live updates
3. class-validator for runtime validation

Key benefits:
- No need for full TypeORM DataSource in browser
- Efficient direct SQL queries with PGLite
- Real-time updates with PGLite live queries
- Type safety from TypeORM entities
- Validation using class-validator decorators

Example Implementation:
```typescript
// Component using live queries with TypeORM types
function UsersTable() {
  const [users, setUsers] = useState<User[]>([]);
  const db = usePGlite();
  
  useEffect(() => {
    const query = 'SELECT * FROM "user" ORDER BY "createdAt" DESC';
    
    // Set up live query
    const setupLive = async () => {
      const liveNamespace = await live.setup(db, {});
      const { unsubscribe } = await liveNamespace.namespaceObj.query<UserRow>(
        query,
        [],
        async (result) => {
          // Map raw rows to TypeORM entities
          const validatedUsers = await Promise.all(
            result.rows.map(async (row) => {
              const user = new User();
              Object.assign(user, {
                ...row,
                createdAt: new Date(row.createdAt),
                updatedAt: new Date(row.updatedAt)
              });
              // Validate using class-validator
              const errors = await validate(user);
              return { user, errors };
            })
          );
          setUsers(validatedUsers.map(({ user }) => user));
        }
      );
      return unsubscribe;
    };

    setupLive();
  }, [db]);
}
```

### Package Structure
```
packages/
  db/
    src/
      entities/          # TypeORM entities with validation decorators
      drivers/
        browser.ts      # PGLite setup + migrations
        server.ts      # Direct SQL with Neon
      migrations/       # TypeORM migrations
      index.ts         # Shared exports
```

### Key Files

1. Entity Definition (`packages/db/src/entities/user/User.ts`):
```typescript
@Entity()
export class User extends BaseEntity {
  @Column()
  @IsString()
  @MinLength(1)
  name: string;

  @Column()
  @IsEmail()
  email: string;

  @Column({ nullable: true })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;
}
```

2. Browser Setup (`packages/db/src/drivers/browser.ts`):
```typescript
export { validate } from "class-validator";
export { entities } from "../entities";
export type EntityInstance = InstanceType<Entity>;
```

3. Migration Runner (`apps/web/src/db/migrations.ts`):
```typescript
export const runMigrations = async (db: PGlite, migrations: MigrationInterface[]) => {
  for (const migration of migrations) {
    const queries = await convertMigration(migration);
    for (const sql of queries) {
      await db.query(sql);
    }
  }
};
```

### Benefits of This Approach

1. **Type Safety**
   - Full TypeScript support using TypeORM entity types
   - Automatic type inference for query results
   - Shared types between front-end and back-end

2. **Validation**
   - Runtime validation using class-validator
   - Reusable validation rules via decorators
   - Consistent validation across environments

3. **Performance**
   - Direct SQL queries without ORM overhead
   - Efficient live updates using PGLite
   - No need for full TypeORM runtime in browser

4. **Developer Experience**
   - Single source of truth for schema (TypeORM entities)
   - Automatic migrations from TypeORM
   - IDE support for SQL queries
   - Real-time updates out of the box

5. **Maintainability**
   - Clear separation of concerns
   - Shared validation logic
   - Easy to add new entities
   - Type-safe database operations

### Migration Process

1. **Entity Creation**
   - Define TypeORM entities with validation decorators
   - Generate migrations using TypeORM CLI
   - Convert migrations to raw SQL for PGLite

2. **Front-End Integration**
   - Import entity types and validation
   - Use PGLite for direct SQL queries
   - Set up live queries for real-time updates
   - Validate data using class-validator

3. **Back-End Integration**
   - Use same entities for type safety
   - Direct SQL with Neon for performance
   - Share validation logic with front-end

## Success Criteria ✅

1. ✅ All entities converted to TypeORM
2. ✅ Validation working in both browser and server
3. ✅ All tests passing
4. ✅ Migrations running successfully
5. ✅ No regression in functionality
6. ✅ Real-time updates working in browser
7. ✅ Offline functionality working

## Next Steps

1. Documentation
   - ✅ Update API documentation
   - ✅ Document SQL patterns
   - ✅ Add migration guides

2. Testing
   - ✅ Add browser-specific tests
   - ✅ Test offline functionality
   - ✅ Test real-time updates

3. Optimization
   - ✅ Add index decorators
   - ✅ Optimize common queries
   - ✅ Improve error handling

## Post-Migration Tasks

1. ✅ Optimize SQL queries for each environment
2. ✅ Add index decorators for performance
3. ❌ Set up continuous integration for migrations
4. 🚧 Create development documentation
5. ✅ Monitor performance metrics
6. ✅ Implement browser-side real-time updates
7. ✅ Add offline capability testing

## Timeline
- ✅ Days 1-3: Setup and Entity Migration
- ✅ Day 4: Database Configuration
- ✅ Days 5-6: Query Layer Implementation
- ✅ Day 7: Migration Generation
- ✅ Days 8-9: Application Code Updates
- ✅ Day 10: Testing
- 🚧 Days 11-12: Cleanup and Documentation

## Next Steps
1. Complete Browser Implementation:
   - ✅ Implement direct SQL queries
   - ✅ Add real-time update triggers
   - ✅ Test offline functionality
   - ✅ Document SQL patterns

2. Finalize Migrations:
   - ✅ Test in both environments
   - ❌ Set up CI/CD pipeline
   - 🚧 Document migration workflow

3. Complete Testing:
   - ✅ Add browser-specific tests
   - ✅ Test offline functionality
   - ✅ Test real-time updates

4. Documentation:
   - ✅ Document SQL patterns
   - ✅ Add migration guides
   - ✅ Create offline mode documentation

## Additional Monorepo Considerations

1. **Package Exports**
```typescript
// packages/db/src/index.ts
// Entity exports
export * from './entities';

// Environment-specific exports
export * from './drivers/browser';
export * from './drivers/server';

// Shared types and utilities
export * from './shared';

// SQL query builders (environment specific)
export * from './queries/browser';
export * from './queries/server';
```

2. **Development Workflow**
- Run `pnpm dev` in root to watch all packages
- Run `pnpm build` before running migrations
- Use `pnpm db:generate` for new migrations
- Use `pnpm db:migrate` to run migrations

3. **Testing Strategy**
- Test SQL queries separately for each environment
- Test browser implementation with PGlite
- Test server implementation with Neon
- Add integration tests in consuming apps 
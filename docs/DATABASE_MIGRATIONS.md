# Database Migrations Guide

This document outlines the process for managing database schema migrations in the project.

## Overview

We use a schema-first approach with LinkML for defining our data models, which are then automatically converted to:
- TypeScript/Zod schemas for runtime validation
- SQL schemas for database structure
- OpenAPI specifications for our REST API

## Database Connection

The project uses a `.dev.vars` file in the `apps/server` directory to store development environment variables, including database connection details. This file should contain:

```env
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require
```

For Neon databases, there are two types of connection strings:
1. Pooled connection (with `-pooler` in the host): Used for regular application connections
2. Direct connection (without `-pooler`): Used for schema migrations and administrative tasks

### Connection Command Format

For schema migrations, always use the direct (non-pooled) connection. You can connect in two ways:

1. Using connection string:
```bash
psql "postgresql://<user>:<password>@<host>/<database>?sslmode=require" -c "YOUR_COMMAND"
```

2. Using individual parameters (recommended):
```bash
PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -c "YOUR_COMMAND"
```

Example with actual command:
```bash
# Export password from .dev.vars (optional)
export PGPASSWORD=$(grep DATABASE_URL apps/server/.dev.vars | sed 's/.*://g' | cut -d '@' -f1)

# Run command
PGPASSWORD=$PGPASSWORD psql -h <host> -U <user> -d <database> -c "\dt"
```

## Migration Process

### 1. Schema Definition

Define or update your schema in the appropriate YAML file under `packages/schema/schemas/models/`. For example, for the User model:

```yaml
# packages/schema/schemas/models/user.yaml
classes:
  User:
    title: User
    description: User account
    is_a: Entity
    attributes:
      name:
        range: string
        required: true
        description: User's full name
      email:
        range: Email
        required: true
        description: User's email address
      # ... other fields
```

### 2. Generate Schema Files

Run the schema generation process:

```bash
cd packages/schema
pnpm generate
```

This will:
1. Merge all schema files
2. Generate TypeScript/Zod schemas
3. Generate SQL schema files

The generated files will be in:
- `packages/schema/src/generated/schemas/` - TypeScript/Zod schemas
- `packages/schema/src/generated/sql/` - SQL schema files

### 3. Apply Database Changes

To apply schema changes to your Neon database:

1. First, drop existing schema if needed:
```bash
PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

2. Then apply the new schema:
```bash
PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -f packages/schema/src/generated/sql/schema.sql
```

### 4. Verify Changes

Check that the tables were created correctly:

```bash
# List all tables
PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -c "\dt"

# Describe specific table
PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -c "\d \"TableName\""
```

## Best Practices

1. **Schema Changes**
   - Always make schema changes in the YAML files
   - Never modify the generated files directly
   - Keep schema changes backward compatible when possible

2. **Version Control**
   - Commit both schema YAML files and generated files
   - Include schema changes in their own commits
   - Document breaking changes in commit messages

3. **Testing**
   - Test migrations on a development branch first
   - Verify all affected API endpoints after migration
   - Check for any broken type safety in the codebase

4. **Deployment**
   - Schedule schema changes during low-traffic periods
   - Have a rollback plan ready
   - Test the entire migration process in staging first

## Common Tasks

### Adding a New Table

1. Create a new YAML file in `packages/schema/schemas/models/`
2. Define your schema using LinkML syntax
3. Run schema generation
4. Apply the changes to the database

### Modifying an Existing Table

1. Update the corresponding YAML file
2. Run schema generation
3. Apply the changes to the database
4. Update any affected TypeScript code

### Adding Indexes

Add them in the schema YAML:

```yaml
attributes:
  indexes:
    range: IndexDefinition
    multivalued: true
    ifabsent: |
      list([
        {
          "name": "idx_custom_index",
          "fields": ["field_name"],
          "unique": true
        }
      ])
```

## Troubleshooting

### Common Issues

1. **Schema Generation Fails**
   - Check YAML syntax
   - Verify all referenced types exist
   - Check for circular dependencies

2. **Migration Fails**
   - Check database connection
   - Look for conflicting table names
   - Check for incompatible type changes
   - Ensure tables are created in correct order (dependencies first)

3. **Type Errors After Migration**
   - Regenerate TypeScript types
   - Update affected code to match new types
   - Check for missing imports

### Recovery Steps

1. If a migration fails:
   ```bash
   # Drop schema and start fresh
   PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
   
   # Reapply schema
   PGPASSWORD=<password> psql -h <host> -U <user> -d <database> -f packages/schema/src/generated/sql/schema.sql
   ```

2. If types are mismatched:
   ```bash
   # Regenerate all types
   cd packages/schema
   pnpm clean
   pnpm generate
   ```

## Support

For issues with:
- Schema definition: Check the LinkML documentation
- Database migrations: Check the Neon documentation
- Type generation: Check the generated files in `src/generated/` 
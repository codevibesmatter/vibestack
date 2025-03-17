# Grid Column Inference

## Overview

Our system automatically generates grid column definitions from TypeORM entities using decorator metadata. This approach ensures consistency between database models and UI representations while minimizing boilerplate code.

## Core Concepts

### 1. Metadata Sources

We derive grid columns from two primary sources:

- **TypeORM Decorators**: Define database structure and relationships
  ```typescript
  @Column({ type: "varchar" })
  name: string;

  @ManyToOne(() => User)
  assignee: User;
  ```

- **Class-validator Decorators**: Define validation rules
  ```typescript
  @IsString()
  @MinLength(1)
  name: string;
  ```

### 2. Column Types

The system automatically maps TypeORM types to grid column types:

| TypeORM Type | Grid Column Type | Editor Component |
|--------------|------------------|------------------|
| varchar/text | text | TextInput |
| int/decimal | number | NumberInput |
| timestamp | date | DatePicker |
| boolean | boolean | Checkbox |
| enum | enum | Select |
| ManyToOne/OneToMany | relation | EntitySelect |
| text[] | tags | TagInput |

### 3. Automatic Inference

```typescript
// Example Entity
@Entity()
class Task extends BaseEntity {
  @Column({ type: "varchar" })
  @IsString()
  @MinLength(1)
  title: string;

  @Column({ type: "enum", enum: TaskStatus })
  @IsEnum(TaskStatus)
  status: TaskStatus;

  @ManyToOne(() => User)
  assignee: User;
}

// Automatically inferred columns
const columns = inferGridColumns(Task);
/* Results in:
[
  {
    field: 'title',
    type: 'text',
    editable: true,
    validation: [
      { type: 'string' },
      { type: 'minLength', constraints: [1] }
    ]
  },
  {
    field: 'status',
    type: 'enum',
    editable: true,
    enumValues: ['OPEN', 'IN_PROGRESS', 'COMPLETED'],
    validation: [
      { type: 'enum', constraints: [TaskStatus] }
    ]
  },
  {
    field: 'assignee',
    type: 'relation',
    editable: true,
    relationTarget: 'User'
  }
]
*/
```

## Adding New Models

When adding a new model to the system:

1. **Define the Entity**
   ```typescript
   @Entity()
   export class NewEntity extends BaseEntity {
     @Column({ type: "varchar" })
     @IsString()
     name: string;
   }
   ```

2. **Register in TypeORM**
   - Add to `entities` array in TypeORM config
   - Create and run migrations

3. **Grid Integration**
   ```typescript
   // The grid will automatically work with your new entity
   const newEntityGrid = createEntityGrid(NewEntity, querySignal);
   ```

4. **Custom Column Behavior (Optional)**
   ```typescript
   const customColumns = inferGridColumns(NewEntity).map(column => {
     if (column.field === 'specialField') {
       return {
         ...column,
         formatter: (value) => `$${value}`,
         width: 120,
         // other customizations
       };
     }
     return column;
   });
   ```

## Best Practices

1. **Type Definitions**
   - Always use appropriate TypeORM column types
   - Include class-validator decorators for validation
   - Make nullable fields explicit with `@IsOptional()`

2. **Relationships**
   - Use appropriate relation decorators (`@ManyToOne`, `@OneToMany`, etc.)
   - Define inverse relationships for better type inference
   - Consider eager/lazy loading implications

3. **Enums**
   - Define as TypeScript enums
   - Use `@IsEnum()` decorator
   - Consider using string values for better readability

4. **Custom Behavior**
   - Extend base column definitions when needed
   - Create reusable formatters and validators
   - Document any non-standard column configurations

## Common Patterns

### 1. Required Fields
```typescript
@Column({ type: "varchar" })
@IsString()
@MinLength(1)
requiredField: string;
```

### 2. Optional Fields
```typescript
@Column({ type: "varchar", nullable: true })
@IsOptional()
@IsString()
optionalField?: string;
```

### 3. Enum Fields
```typescript
@Column({ type: "enum", enum: Status })
@IsEnum(Status)
status: Status;
```

### 4. Relations
```typescript
@ManyToOne(() => User)
@JoinColumn({ name: "userId" })
user: User;

@Column({ type: "uuid" })
userId: string;
```

## Troubleshooting

1. **Column Not Appearing**
   - Check entity registration
   - Verify column decorators
   - Check for circular dependencies

2. **Wrong Column Type**
   - Verify TypeORM column type
   - Check type mappings
   - Consider custom type converter

3. **Validation Not Working**
   - Verify class-validator decorators
   - Check validation registration
   - Debug validation metadata

## Future Improvements

1. **Planned Features**
   - Custom column renderers
   - Advanced filtering options
   - Batch editing support
   - Column templates

2. **Performance Optimizations**
   - Metadata caching
   - Lazy column generation
   - Virtual scrolling

3. **Developer Experience**
   - Better type inference
   - Debug tooling
   - Migration helpers 
# Data Table Component Library

A powerful, extensible data table system for React applications with TypeORM integration.

## Features

- 📊 **Flexible Data Rendering**: Display and edit various data types including text, numbers, booleans, dates, and relationships
- 🔄 **TypeORM Integration**: Automatic column generation from TypeORM entity metadata
- 🔌 **Plugin System**: Extend functionality with custom cell renderers and column enhancers
- ⚙️ **Global Configuration**: Centralized settings through a provider system
- 🛠️ **Error Handling**: Comprehensive error management with retry capabilities
- 🎛️ **Column Visibility**: User control over which columns to display
- 🔍 **Sorting & Filtering**: Built-in data manipulation capabilities
- 🎯 **Relationship Support**: Handle entity relationships including one-to-many and many-to-many

## Core Components

### DataTable

The main table component that combines all features.

```tsx
import { DataTable } from '@/components/data-table/data-table'

<DataTable
  columns={columns}
  data={tasks}
  sorting={sorting}
  setSorting={setSorting}
  onUpdate={handleTaskUpdate}
  editableColumns={['title', 'status', 'priority']}
  isLoading={isLoading}
  showColumnVisibility={true}
/>
```

### Cell Components

Specialized cell renderers for different data types:

- `EditableTextCell`: For text input
- `EditableNumberCell`: For numeric input
- `EditableCheckboxCell`: For boolean values
- `EditableDateCell`: For date selection
- `EditableSelectCell`: For enum/option selection
- `EditableRelationshipCell`: For entity relationships

### Configuration Provider

Global configuration for all data tables:

```tsx
import { DataTableProvider } from '@/components/data-table/data-table-provider'

<DataTableProvider 
  initialConfig={{
    defaultPageSize: 20,
    cacheExpiryTime: 10 * 60 * 1000, // 10 minutes
    retryOnError: true
  }}
>
  <App />
</DataTableProvider>
```

### Plugin System

Extend functionality with custom plugins:

```tsx
import { pluginRegistry } from '@/components/data-table/data-table-plugins'

// Register a custom cell plugin
pluginRegistry.registerCellPlugin({
  id: 'custom-status-badge',
  name: 'Status Badge',
  canHandle: (context) => context.column.id === 'status',
  render: (context) => {
    const status = context.getValue()
    return <StatusBadge status={status} />
  }
})
```

### TypeORM Integration

Generate columns from entity metadata:

```tsx
import { generateColumnsFromTypeORM } from '@/components/data-table/data-table-typeorm'

const columns = generateColumnsFromTypeORM(taskEntityMetadata, {
  excludeColumns: ['createdAt', 'updatedAt'],
  editableColumns: ['title', 'description', 'status'],
  enumMappings: {
    status: Object.values(TaskStatus).map(s => ({ label: s, value: s }))
  }
})
```

For advanced relationship handling:

```tsx
import { generateAdvancedColumns } from '@/components/data-table/data-table-typeorm-advanced'

const columns = generateAdvancedColumns(taskEntityMetadata, {
  relationshipConfigs: {
    project: {
      service: projectService,
      displayField: 'name',
      emptyLabel: 'No Project'
    }
  }
})
```

### Error Handling

Wrap tables with error boundaries:

```tsx
import { DataTableErrorBoundary } from '@/components/data-table/data-table-error'

<DataTableErrorBoundary>
  <DataTable {...props} />
</DataTableErrorBoundary>
```

Or use the data fetching hook:

```tsx
import { useDataFetchWithErrorHandling } from '@/components/data-table/data-table-error'

const { data, loading, error, retry } = useDataFetchWithErrorHandling(
  () => taskService.getAll()
)
```

## Entity Cache System

The library includes a built-in entity caching system to reduce redundant API calls, especially useful for relationship data. The cache automatically expires after a configurable time period.

## Best Practices

1. **Use Error Boundaries**: Always wrap your tables with error boundaries to prevent crashes
2. **Configure for Performance**: Adjust cache settings based on data volatility
3. **Customize Cell Rendering**: Create specialized cell renderers for common data patterns
4. **Split Large Tables**: For complex UIs, consider splitting tables into smaller, focused components
5. **Standardize Entity Access**: Use consistent service patterns for entity access

## TypeScript Support

All components are fully typed for TypeScript support, including generics for your entity types.

## Advanced Configuration

See the documentation for each component for detailed configuration options and advanced use cases. 
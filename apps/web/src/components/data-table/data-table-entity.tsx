import React, { useState, useEffect, useMemo } from 'react'
import { SortingState } from '@tanstack/react-table'
import { SelectQueryBuilder, ObjectLiteral } from 'typeorm'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable } from './data-table'
import { DataTableErrorBoundary, DataTableError } from './data-table-error' // Removed useDataFetchWithErrorHandling
import { useDataTable, useEntityConfig, EntityConfig as DataTableEntityConfig } from './data-table-provider'
import { DataTablePluginProvider } from './data-table-plugins'
import { generateColumnsFromTypeORM, TypeORMColumnOptions } from './data-table-typeorm.tsx'
import { useLiveEntity } from '../../db/hooks/useLiveEntity' // Added useLiveEntity import

// Type definitions for the EntityDataTable
export interface EntityDataTableProps<T extends ObjectLiteral & { id: string; createdAt?: string | Date; updatedAt?: string | Date }> {
  // Unique ID for this table instance, used for persistence
  tableId: string

  // Entity type to display
  entityType: string
  
  // Entity metadata - usually from TypeORM
  entityMetadata?: any
  
  // Service for data access
  service: {
    // getAll: () => Promise<T[]> // To be removed
    getRepo: () => any // Assuming getRepo returns a TypeORM repository instance
    getById?: (id: string) => Promise<T | null>
    update: (id: string, data: Partial<T>) => Promise<T>
    delete?: (id: string) => Promise<void>
    create?: (data: Partial<T>) => Promise<T>
  }
  
  // Optional services for related entities
  relatedServices?: Record<string, any>
  
  // Optional TypeORM column options
  typeormOptions?: TypeORMColumnOptions
  
  // Display options
  title?: string
  showCard?: boolean
  
  // Custom columns - overrides auto-generated columns
  customColumns?: any[]
  customEditableColumns?: string[]; // ADDED: For explicit editable columns control
  
  // Table configuration
  tableConfig?: {
    pageSize?: number
    enableSorting?: boolean
    showColumnVisibility?: boolean
    enablePagination?: boolean
  }
  
  // Additional table props
  additionalTableProps?: Record<string, any>
  
  // Callbacks
  onEntityUpdated?: (entity: T) => void
  onEntityDeleted?: (id: string) => void
  onEntityCreated?: (entity: T) => void

  // Optional live query builder
  liveQueryBuilder: SelectQueryBuilder<T>;
}

/**
 * EntityDataTable - A drop-in data table for any entity
 */
export function EntityDataTable<T extends ObjectLiteral & { id: string; createdAt?: string | Date; updatedAt?: string | Date }>({
  tableId,
  entityType,
  entityMetadata,
  service,
  relatedServices = {},
  typeormOptions = {},
  title = '',
  showCard = true,
  customColumns,
  customEditableColumns, // ADDED
  tableConfig = {},
  additionalTableProps = {},
  onEntityUpdated,
  onEntityDeleted,
  onEntityCreated,
  liveQueryBuilder: propsLiveQueryBuilder // Renamed to avoid conflict
}: EntityDataTableProps<T>) {
  // Get global configuration
  const { config: globalConfig } = useDataTable()
  const { config: entityConfig } = useEntityConfig(entityType)
  
  // Set up local state for sorting
  const initialSortingFromConfig = entityConfig?.defaultSorting || []
  // The local sorting state might be used for non-persisted scenarios or if DataTable needs it.
  // For persisted state, DataTable will manage its own sorting internally using defaultSorting.
  const [sorting, setSorting] = useState<SortingState>(initialSortingFromConfig)
  
  // Set up entity column options
  const effectiveTypeormOptions = useMemo(() => {
    // Start with the base options
    const options = {
      ...typeormOptions,
      entityName: entityType,
      enableEntityPlugins: true,
    };
    
    // Handle relationship configs separately to avoid property conflicts
    const combinedRelationshipConfigs = { ...(typeormOptions.relationshipConfigs || {}) };
    
    // Add relationship configs from related services if not already defined
    Object.entries(relatedServices).forEach(([key, svc]) => {
      if (!combinedRelationshipConfigs[key]) {
        combinedRelationshipConfigs[key] = {
          service: svc,
          displayField: 'name' // Default display field
        };
      }
    });
    
    return {
      ...options,
      relationshipConfigs: combinedRelationshipConfigs
    };
  }, [entityType, relatedServices, typeormOptions]);

  // Determine Query Builder
  const determinedQueryBuilder = propsLiveQueryBuilder;

  // Fetch data using useLiveEntity
  const { data: liveData, loading: liveLoading, error: liveError } = useLiveEntity<T>(
    determinedQueryBuilder,
    { enabled: !!determinedQueryBuilder, transform: true }
  );
  
  // Generate columns from entity metadata if available
  const columns = useMemo(() => {
    if (customColumns) return customColumns
    
    if (entityMetadata) {
      return generateColumnsFromTypeORM<T>(entityMetadata, effectiveTypeormOptions)
    }
    
    // If no entity metadata and no custom columns, return empty array
    console.warn(`No entity metadata or custom columns provided for ${entityType}`)
    return []
  }, [customColumns, entityMetadata, effectiveTypeormOptions, entityType])
  
  // Handle entity updates
  const handleUpdate = async (rowId: string, columnId: string, value: any): Promise<void> => {
    try {
      const updateData = { [columnId]: value } as unknown as Partial<T>
      const updatedEntity = await service.update(rowId, updateData)
      onEntityUpdated?.(updatedEntity)
      return Promise.resolve()
    } catch (error) {
      console.error(`Error updating ${entityType}:`, error)
      return Promise.reject(error)
    }
  }
  
  // If there's an error, show error state
  if (liveError) {
    return (
      <DataTableError
        error={liveError}
        // TODO: Implement a retry mechanism for useLiveEntity if possible, or remove onRetry if not applicable.
        // For now, onRetry might not do anything meaningful without a way to re-trigger useLiveEntity's fetch.
        // onRetry={() => { /* Potentially re-evaluate determinedQueryBuilder or trigger refetch in useLiveEntity */ }}
        title={`Error Loading ${title || entityType}`}
        description={`There was an error fetching ${entityType} data.`}
      />
    )
  }
  
  // Prepare the table component
  const tableComponent = (
    <DataTablePluginProvider entityType={entityType}>
      <DataTableErrorBoundary>
        <DataTable
          tableId={tableId} // Pass the new tableId prop
          columns={columns}
          data={liveData || []} // Use liveData
          sorting={sorting} // Kept for potential non-persisted use or if DataTable still uses it
          setSorting={setSorting} // Kept for potential non-persisted use
          defaultSorting={initialSortingFromConfig} // Pass default sorting from entity config for persistence
          onUpdate={handleUpdate}
          isLoading={liveLoading} // Use liveLoading
          editableColumns={customEditableColumns ?? entityConfig?.defaultEditableFields ?? []} // UPDATED: Prioritize prop
          // Configuration props:
          // DataTable expects 'pageSize' for initial/default page size.
          pageSize={tableConfig.pageSize ?? entityConfig?.pageSize ?? globalConfig.defaultPageSize}
          // For boolean toggles, source from tableConfig, then entityConfig (if it has corresponding default), then hardcoded.
          showColumnVisibility={tableConfig.showColumnVisibility ?? globalConfig.defaultColumnVisibility ?? true}
          enablePagination={tableConfig.enablePagination ?? globalConfig.showPagination ?? true}
          enableSorting={tableConfig.enableSorting ?? true}
          tableReady={!liveLoading} // Use liveLoading
          {...additionalTableProps}
        />
      </DataTableErrorBoundary>
    </DataTablePluginProvider>
  )
  
  // Optionally wrap in a card
  if (showCard) {
    return (
      <Card>
        {title && (
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
        )}
        <CardContent>
          {tableComponent}
        </CardContent>
      </Card>
    )
  }
  
  return tableComponent
}

/**
 * Register a global entity configuration
 */
export function registerEntityConfig(
  entityType: string, 
  config: DataTableEntityConfig
) {
  const { updateEntityConfig } = useDataTable()
  updateEntityConfig(entityType, config)
}

/**
 * A simplified version of the EntityDataTable that uses a repository pattern
 */
export function RepositoryDataTable<T extends ObjectLiteral & { id: string; createdAt?: string | Date; updatedAt?: string | Date }>({
  repository,
  entityType,
  customEditableColumns, // ADDED
  ...props
}: Omit<EntityDataTableProps<T>, 'service' | 'entityType' | 'tableId' | 'liveQueryBuilder' | 'customEditableColumns'> & {
  repository: any,
  entityType: string,
  tableId?: string, // Make tableId optional here, can be derived from entityType if not provided
  customEditableColumns?: string[]; // ADDED explicit prop for RepositoryDataTable
}) {
  // Create a service from the repository
  const service = useMemo(() => ({
    getRepo: () => repository, // Added getRepo
    getById: (id: string) => repository.findOne(id),
    update: (id: string, data: Partial<T>) => repository.update(id, data),
    delete: (id: string) => repository.delete(id),
    create: (data: Partial<T>) => repository.save(data)
    // getAll removed as it's handled by useLiveEntity now
  }), [repository])
  
  // If tableId is not provided to RepositoryDataTable, we can construct one,
  // e.g., by using the entityType. This ensures EntityDataTable always gets a tableId.
  const effectiveTableId = props.tableId || `repo-${entityType}-table`;

  // Construct a "select all" live query for the given repository
  const entityAlias = entityType.toLowerCase();
  const liveQueryBuilder = repository.createQueryBuilder(entityAlias).select();

  return (
    <EntityDataTable
      tableId={effectiveTableId}
      entityType={entityType}
      service={service}
      entityMetadata={repository.metadata}
      liveQueryBuilder={liveQueryBuilder} // Pass the liveQueryBuilder
      customEditableColumns={customEditableColumns} // Pass through
      {...props}
    />
  )
}
import React from 'react'
import { ColumnDef } from '@tanstack/react-table'
import { EntityMetadata } from 'typeorm'
import { 
  EditableTextCell, 
  EditableNumberCell, 
  EditableDateCell,
  EditableCheckboxCell,
  EditableSelectCell,
  EditableRelationshipCell,
  RelationshipCell
} from './data-table-cells'
import { pluginRegistry } from './data-table-plugins'

// TypeORM column metadata types
export interface TypeORMColumnMetadata {
  propertyName: string
  propertyType: string
  isNullable?: boolean
  isEnum?: boolean
  enumName?: string
  type?: string
  isArray?: boolean
  isPrimary?: boolean
  isGenerated?: boolean
  length?: number
  options?: any
  relationMetadata?: any
}

export interface TypeORMEntityMetadata {
  name: string
  columns: TypeORMColumnMetadata[]
  relations: Array<{
    propertyName: string
    isManyToOne: boolean
    isOneToOne: boolean
  }>
}

// Types and interfaces
export interface TypeORMColumnOptions {
  // Basic configuration
  excludeColumns?: string[]
  editableColumns?: string[]
  visibleColumns?: string[] | 'all'
  
  // Custom column options
  columnOverrides?: {
    [key: string]: Partial<ColumnDef<any, any>>
  }
  
  // Enum mappings for select fields
  enumMappings?: {
    [key: string]: { label: string, value: any }[]
  }
  
  // Relationship configuration
  relationshipConfigs?: {
    [key: string]: {
      service: any
      displayField: string
      emptyLabel?: string
      filterEntities?: (entities: any[]) => any[]
    }
  }
  
  // Enable entity-aware plugins
  enableEntityPlugins?: boolean
  entityName?: string
}

// Main function to generate columns from entity metadata
export function generateColumnsFromTypeORM<T>(
  entityMetadata: TypeORMEntityMetadata | EntityMetadata,
  options: TypeORMColumnOptions = {}
): ColumnDef<T, any>[] {
  const { 
    excludeColumns = [], 
    editableColumns = [],
    visibleColumns = 'all',
    columnOverrides = {},
    enumMappings = {},
    relationshipConfigs = {},
    enableEntityPlugins = true,
    entityName
  } = options
  
  // Get entity columns from metadata
  const columns = entityMetadata.columns
    .filter(column => !excludeColumns.includes(column.propertyName))
    .map(column => {
      // Base column definition
      const columnDef: ColumnDef<T, any> = {
        accessorKey: column.propertyName,
        header: formatHeader(column.propertyName),
        enableHiding: true,
        enableSorting: true,
      }
      
      // Check if column should be visible
      if (visibleColumns !== 'all' && !visibleColumns.includes(column.propertyName)) {
        columnDef.enableHiding = false
      }
      
      // Apply cell renderer based on column type
      const isEditable = editableColumns.includes(column.propertyName)
      
      if (isEditable) {
        // Determine column type and use appropriate cell renderer
        if (column.relationMetadata) {
          // This is a relation column
          columnDef.cell = (props) => {
            const relationConfig = relationshipConfigs[column.propertyName]
            if (!relationConfig) {
              return <div>{String(props.getValue() || '')}</div>
            }
            
            return (
              <EditableRelationshipCell<T, any> 
                {...props} 
                relationshipConfig={{
                  fetchOne: (id) => relationConfig.service.findOne(id) as Promise<any>,
                  fetchAll: () => relationConfig.service.find() as Promise<any[]>,
                  getDisplayValue: (entity) => entity[relationConfig.displayField],
                  emptyLabel: relationConfig.emptyLabel || `No ${formatHeader(column.propertyName)}`,
                  filterEntities: relationConfig.filterEntities
                }}
              />
            )
          }
        } else if (column.type === 'boolean') {
          columnDef.cell = (props) => <EditableCheckboxCell {...props} />
        } else if (column.type === 'date' || column.type === 'datetime') {
          columnDef.cell = (props) => <EditableDateCell {...props} />
        } else if (column.type === 'number' || column.type === 'int' || column.type === 'float') {
          columnDef.cell = (props) => <EditableNumberCell {...props} />
        } else if (enumMappings[column.propertyName]) {
          // Handle enum columns with select cell
          columnDef.cell = (props) => (
            <EditableSelectCell {...props} options={enumMappings[column.propertyName]} />
          )
        } else {
          // Default to text cell
          columnDef.cell = (props) => <EditableTextCell {...props} />
        }
      } else {
        // Non-editable columns
        if (column.relationMetadata) {
          // This is a relation column
          columnDef.cell = (props) => {
            const relationConfig = relationshipConfigs[column.propertyName]
            if (!relationConfig) {
              return <div>{String(props.getValue() || '')}</div>
            }
            
            return (
              <RelationshipCell<T, any>
                {...props} 
                relationshipConfig={{
                  fetchOne: (id) => relationConfig.service.findOne(id) as Promise<any>,
                  getDisplayValue: (entity) => entity[relationConfig.displayField],
                  emptyLabel: relationConfig.emptyLabel || `No ${formatHeader(column.propertyName)}`
                }}
              />
            )
          }
        }
      }
      
      // Apply any column overrides
      if (columnOverrides[column.propertyName]) {
        Object.assign(columnDef, columnOverrides[column.propertyName])
      }
      
      return columnDef
    })
  
  // Add relation columns that aren't directly in the columns array
  entityMetadata.relations
    .filter(relation => 
      !columns.some(col => col.accessorKey === relation.propertyName) && 
      !excludeColumns.includes(relation.propertyName)
    )
    .forEach(relation => {
      if (relation.isManyToOne || relation.isOneToOne) {
        // Handle singular relations
        const columnDef: ColumnDef<T, any> = {
          accessorKey: relation.propertyName,
          header: formatHeader(relation.propertyName),
          enableHiding: true,
          enableSorting: true,
        }
        
        // Check if relation is editable
        const isEditable = editableColumns.includes(relation.propertyName)
        
        if (isEditable && relationshipConfigs[relation.propertyName]) {
          const relationConfig = relationshipConfigs[relation.propertyName]
          columnDef.cell = (props) => (
            <EditableRelationshipCell<T, any> 
              {...props} 
              relationshipConfig={{
                fetchOne: (id) => relationConfig.service.findOne(id) as Promise<any>,
                fetchAll: () => relationConfig.service.find() as Promise<any[]>,
                getDisplayValue: (entity) => entity[relationConfig.displayField],
                emptyLabel: relationConfig.emptyLabel || `No ${formatHeader(relation.propertyName)}`,
                filterEntities: relationConfig.filterEntities
              }}
            />
          )
        } else if (relationshipConfigs[relation.propertyName]) {
          const relationConfig = relationshipConfigs[relation.propertyName]
          columnDef.cell = (props) => (
            <RelationshipCell<T, any>
              {...props} 
              relationshipConfig={{
                fetchOne: (id) => relationConfig.service.findOne(id) as Promise<any>,
                fetchAll: () => relationConfig.service.find() as Promise<any[]>,
                getDisplayValue: (entity) => entity[relationConfig.displayField],
                emptyLabel: relationConfig.emptyLabel || `No ${formatHeader(relation.propertyName)}`,
                filterEntities: relationConfig.filterEntities
              }}
            />
          )
        }
        
        columns.push(columnDef)
      }
    })
  
  // Apply any entity-specific plugins if enabled
  if (enableEntityPlugins && entityName) {
    // Find all plugins that apply to this entity
    const plugins = pluginRegistry.getAllColumnPlugins()
      .filter(plugin => {
        // Check if plugin has entity metadata
        const metadata = (plugin as any).entityTypes
        if (!metadata) return false
        
        // Check if plugin applies to this entity
        return metadata.includes(entityName)
      })
    
    // Apply plugins to enhance columns
    plugins.forEach(plugin => {
      columns.forEach((col, index) => {
        columns[index] = plugin.enhanceColumn(
          col.accessorKey as string, 
          col, 
          { entityMetadata, options }
        )
      })
    })
  }
  
  return columns
}

// Helper to format column headers
function formatHeader(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim()
}

// Simple function for backwards compatibility
export function generateColumnsFromEntity<T>(
  entityMetadata: TypeORMEntityMetadata | EntityMetadata,
  options: TypeORMColumnOptions = {}
): ColumnDef<T, any>[] {
  return generateColumnsFromTypeORM<T>(entityMetadata, options)
}

// Export the previously separate "advanced" function as well for API compatibility
export const generateAdvancedColumns = generateColumnsFromTypeORM

/**
 * Formats a camelCase or snake_case column name into a readable title
 */
function formatColumnName(name: string): string {
  // Handle snake_case
  if (name.includes('_')) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
  
  // Handle camelCase
  return name
    // Insert a space before all caps and uppercase the first character
    .replace(/([A-Z])/g, ' $1')
    // Uppercase the first character
    .replace(/^./, str => str.toUpperCase())
} 
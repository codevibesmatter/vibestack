import * as React from 'react'
import { CellContext } from '@tanstack/react-table'

// Define interfaces for plugins
export interface DataTableCellPlugin<TData, TValue> {
  id: string
  name: string
  description?: string
  
  // Function to check if this plugin can handle the given cell
  canHandle: (context: CellContext<TData, TValue>) => boolean
  
  // Function to render the cell
  render: (context: CellContext<TData, TValue>) => React.ReactNode
  
  // Optional: entity types this plugin applies to
  entityTypes?: string[]
}

export interface DataTableColumnPlugin {
  id: string
  name: string
  description?: string
  
  // Function to enhance a column definition
  enhanceColumn: (
    columnId: string, 
    columnDef: any, 
    options?: any
  ) => any
  
  // Optional: entity types this plugin applies to
  entityTypes?: string[]
}

// Extended plugin registry to support entity-awareness
class DataTablePluginRegistry {
  private cellPlugins: Map<string, DataTableCellPlugin<any, any>> = new Map()
  private columnPlugins: Map<string, DataTableColumnPlugin> = new Map()
  private entityPluginMap: Map<string, string[]> = new Map()
  
  // Register a cell plugin
  registerCellPlugin<TData, TValue>(plugin: DataTableCellPlugin<TData, TValue>) {
    if (this.cellPlugins.has(plugin.id)) {
      console.warn(`Plugin with ID ${plugin.id} already exists and will be overwritten`)
    }
    
    this.cellPlugins.set(plugin.id, plugin)
    
    // Register entity associations if provided
    if (plugin.entityTypes && plugin.entityTypes.length > 0) {
      plugin.entityTypes.forEach(entityType => {
        const plugins = this.entityPluginMap.get(entityType) || []
        if (!plugins.includes(plugin.id)) {
          plugins.push(plugin.id)
          this.entityPluginMap.set(entityType, plugins)
        }
      })
    }
    
    return this // For chaining
  }
  
  // Register a column plugin
  registerColumnPlugin(plugin: DataTableColumnPlugin) {
    if (this.columnPlugins.has(plugin.id)) {
      console.warn(`Plugin with ID ${plugin.id} already exists and will be overwritten`)
    }
    
    this.columnPlugins.set(plugin.id, plugin)
    
    // Register entity associations if provided
    if (plugin.entityTypes && plugin.entityTypes.length > 0) {
      plugin.entityTypes.forEach(entityType => {
        const plugins = this.entityPluginMap.get(entityType) || []
        if (!plugins.includes(plugin.id)) {
          plugins.push(plugin.id)
          this.entityPluginMap.set(entityType, plugins)
        }
      })
    }
    
    return this // For chaining
  }
  
  // Get a cell plugin by ID
  getCellPlugin(id: string) {
    return this.cellPlugins.get(id) || null
  }
  
  // Get a column plugin by ID
  getColumnPlugin(id: string) {
    return this.columnPlugins.get(id) || null
  }
  
  // Get all cell plugins
  getAllCellPlugins() {
    return Array.from(this.cellPlugins.values())
  }
  
  // Get all column plugins
  getAllColumnPlugins() {
    return Array.from(this.columnPlugins.values())
  }
  
  // Get plugins for specific entity type
  getPluginsForEntity(entityType: string) {
    const pluginIds = this.entityPluginMap.get(entityType) || []
    
    return {
      cellPlugins: this.getAllCellPlugins().filter(plugin => 
        !plugin.entityTypes || 
        plugin.entityTypes.includes(entityType)
      ),
      columnPlugins: this.getAllColumnPlugins().filter(plugin => 
        !plugin.entityTypes || 
        plugin.entityTypes.includes(entityType)
      )
    }
  }
  
  // Find a cell plugin that can handle the given cell
  findCellPluginForContext<TData, TValue>(
    context: CellContext<TData, TValue>,
    entityType?: string
  ) {
    // If entity type is provided, try entity-specific plugins first
    if (entityType) {
      for (const plugin of this.getAllCellPlugins()) {
        if (
          plugin.entityTypes?.includes(entityType) && 
          plugin.canHandle(context)
        ) {
          return plugin
        }
      }
    }
    
    // Fall back to checking all plugins
    for (const plugin of this.cellPlugins.values()) {
      if (plugin.canHandle(context)) {
        return plugin
      }
    }
    
    return null
  }
}

// Create a singleton instance of the registry
export const pluginRegistry = new DataTablePluginRegistry()

// Context for plugin system with entity type
interface PluginContextType {
  registry: DataTablePluginRegistry
  entityType?: string
}

const DataTablePluginContext = React.createContext<PluginContextType | null>(null)

// Provider component for plugin system
export function DataTablePluginProvider({
  children,
  registry = pluginRegistry,
  entityType,
}: {
  children: React.ReactNode
  registry?: DataTablePluginRegistry
  entityType?: string
}) {
  const contextValue = React.useMemo(() => ({
    registry,
    entityType
  }), [registry, entityType])
  
  return (
    <DataTablePluginContext.Provider value={contextValue}>
      {children}
    </DataTablePluginContext.Provider>
  )
}

// Enhanced hook to use plugin registry with entity awareness
export function useDataTablePlugins() {
  const context = React.useContext(DataTablePluginContext)
  
  if (!context) {
    // Fall back to singleton if not in a provider
    return { 
      registry: pluginRegistry,
      entityType: undefined
    }
  }
  
  return context
}

// Smart cell renderer that uses registered plugins with entity awareness
export function SmartCellRenderer<TData, TValue>({
  context,
  fallback,
  entityType,
}: {
  context: CellContext<TData, TValue>
  fallback?: React.ReactNode
  entityType?: string
}) {
  const { registry, entityType: contextEntityType } = useDataTablePlugins()
  const effectiveEntityType = entityType || contextEntityType
  
  const plugin = registry.findCellPluginForContext(context, effectiveEntityType)
  
  if (plugin) {
    return <>{plugin.render(context)}</>
  }
  
  // Convert value to string or use fallback to ensure it's a valid ReactNode
  const value = context.getValue()
  return <>{fallback || (value != null ? String(value) : '')}</>
} 
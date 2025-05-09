import * as React from 'react'

// Types for the data table configuration
export interface DataTableConfig {
  // Global behavior settings
  defaultPageSize: number
  showPagination: boolean
  
  // Default appearance settings
  defaultColumnVisibility: boolean
  
  // Default error handling behavior
  retryOnError: boolean
  maxRetryAttempts: number
  
  // Default rendering settings
  loadingMessage: string
  emptyMessage: string
  errorMessage: string
  
  // Entity cache settings
  cacheExpiryTime: number // in milliseconds
}

// Entity-specific configuration
export interface EntityConfig {
  // Default fields to display for entity type
  defaultFields?: string[]
  
  // Default editable fields for entity type
  defaultEditableFields?: string[]
  
  // Default sorting for entity type
  defaultSorting?: { id: string, desc: boolean }[]
  
  // Default field formatting
  fieldFormatters?: {
    [fieldName: string]: (value: any) => string
  }
  
  // Default per-entity page size
  pageSize?: number
  
  // Custom display labels for fields
  fieldLabels?: {
    [fieldName: string]: string
  }
}

// Default configuration values
const defaultConfig: DataTableConfig = {
  defaultPageSize: 10,
  showPagination: true,
  defaultColumnVisibility: true,
  retryOnError: true,
  maxRetryAttempts: 3,
  loadingMessage: "Loading data...",
  emptyMessage: "No results found.",
  errorMessage: "An error occurred while loading data.",
  cacheExpiryTime: 5 * 60 * 1000, // 5 minutes
}

// Extended context including entity configurations
interface DataTableContextValue {
  config: DataTableConfig
  updateConfig: (newConfig: Partial<DataTableConfig>) => void
  entityConfigs: Record<string, EntityConfig>
  updateEntityConfig: (entityType: string, config: Partial<EntityConfig>) => void
  getEntityConfig: (entityType: string) => EntityConfig | undefined
}

// Create the context with default values
const DataTableContext = React.createContext<DataTableContextValue>({
  config: defaultConfig,
  updateConfig: () => {},
  entityConfigs: {},
  updateEntityConfig: () => {},
  getEntityConfig: () => undefined,
})

// Custom hook to use the data table context
export function useDataTable() {
  const context = React.useContext(DataTableContext)
  
  if (!context) {
    throw new Error('useDataTable must be used within a DataTableProvider')
  }
  
  return context
}

// Helper hook to get configuration for a specific entity
export function useEntityConfig(entityType: string) {
  const { getEntityConfig, updateEntityConfig } = useDataTable()
  
  return {
    config: getEntityConfig(entityType),
    updateConfig: (newConfig: Partial<EntityConfig>) => 
      updateEntityConfig(entityType, newConfig)
  }
}

// Provider component
export function DataTableProvider({
  children,
  initialConfig = {},
  initialEntityConfigs = {},
}: {
  children: React.ReactNode
  initialConfig?: Partial<DataTableConfig>
  initialEntityConfigs?: Record<string, EntityConfig>
}) {
  // Merge the initial config with the default config
  const [config, setConfig] = React.useState<DataTableConfig>({
    ...defaultConfig,
    ...initialConfig,
  })
  
  // Store entity-specific configurations
  const [entityConfigs, setEntityConfigs] = React.useState<Record<string, EntityConfig>>(
    initialEntityConfigs
  )
  
  // Function to update the config
  const updateConfig = React.useCallback((newConfig: Partial<DataTableConfig>) => {
    setConfig((prevConfig) => ({
      ...prevConfig,
      ...newConfig,
    }))
  }, [])
  
  // Function to update entity config
  const updateEntityConfig = React.useCallback((
    entityType: string, 
    newConfig: Partial<EntityConfig>
  ) => {
    setEntityConfigs(prev => ({
      ...prev,
      [entityType]: {
        ...(prev[entityType] || {}),
        ...newConfig
      }
    }))
  }, [])
  
  // Function to get entity config
  const getEntityConfig = React.useCallback(
    (entityType: string) => entityConfigs[entityType],
    [entityConfigs]
  )
  
  // Memoize the context value to prevent unnecessary renders
  const contextValue = React.useMemo(
    () => ({
      config,
      updateConfig,
      entityConfigs,
      updateEntityConfig,
      getEntityConfig,
    }),
    [config, updateConfig, entityConfigs, updateEntityConfig, getEntityConfig]
  )
  
  return (
    <DataTableContext.Provider value={contextValue}>
      {children}
    </DataTableContext.Provider>
  )
} 
import * as React from 'react'
import { CellContext } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { format } from 'date-fns'
import { CalendarIcon } from '@radix-ui/react-icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { usePGliteContext } from '@/db/pglite-provider'
import { Project, User } from '@repo/dataforge/client-entities'

// Cache for storing entities across component instances
// Keys are `${serviceName}:${entitiesType}` (e.g., 'projects:all')
export interface EntityCache {
  [key: string]: {
    entities: any[],
    timestamp: number,
    loading: boolean,
    promise: Promise<any[]> | null,
    error: Error | null
  }
}

// Global entity cache with 5 minute expiration
export const ENTITY_CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes in milliseconds
export const globalEntityCache: EntityCache = {};

// Export a constant to use as cache key prefix for consistent access
export const RELATIONSHIP_CACHE_KEYPREFIX = 'relationship:';

/**
 * Hook for accessing cached entities
 * @param cacheKey Unique key for the cache entry
 * @param fetchFn Function to fetch entities if not in cache
 * @returns [entities, loading, error, refreshCache]
 */
function useCachedEntities<T>(
  cacheKey: string, 
  fetchFn: () => Promise<T[]>
): [T[], boolean, Error | null, () => void] {
  const [, forceUpdate] = React.useState({});
  
  // Initialize cache entry if it doesn't exist
  if (!globalEntityCache[cacheKey]) {
    globalEntityCache[cacheKey] = {
      entities: [],
      timestamp: 0,
      loading: false,
      promise: null,
      error: null
    };
  }
  
  const cache = globalEntityCache[cacheKey];
  
  // Check if cache is expired
  const isExpired = Date.now() - cache.timestamp > ENTITY_CACHE_EXPIRY;
  
  // Function to refresh the cache
  const refreshCache = React.useCallback(() => {
    // Skip if already loading
    if (cache.loading) return;
    
    cache.loading = true;
    cache.error = null;
    
    // Force component to re-render to show loading state
    forceUpdate({});
    
    // Create and store the promise
    cache.promise = fetchFn()
      .then(data => {
        cache.entities = data;
        cache.timestamp = Date.now();
        cache.loading = false;
        cache.error = null;
        
        // Force update to render with new data
        forceUpdate({});
        return data;
      })
      .catch(error => {
        cache.error = error;
        cache.loading = false;
        
        // Force update to render error state
        forceUpdate({});
        throw error;
      });
  }, [cache, fetchFn]);
  
  // Load data on mount or when cache is expired
  React.useEffect(() => {
    if (cache.entities.length === 0 || isExpired) {
      refreshCache();
    }
  }, [cache.entities.length, isExpired, refreshCache]);
  
  return [cache.entities, cache.loading, cache.error, refreshCache];
}

interface EditableCellProps<TData, TValue> extends CellContext<TData, TValue> {
  showEditIcons?: boolean
}

/**
 * Editable Text Cell - for text, number, etc.
 */
export function EditableTextCell<TData, TValue>({
  getValue,
  row,
  column,
  table,
}: CellContext<TData, TValue>) {
  const initialValue = getValue() as string
  const [value, setValue] = React.useState(initialValue)
  const [isEditing, setIsEditing] = React.useState(false)

  // Check if this column is editable
  const meta = table.options.meta
  const editable = meta?.editableColumns?.includes(column.id)

  // Reset the value when the initialValue changes (e.g. external data update)
  React.useEffect(() => {
    setValue(initialValue)
  }, [initialValue])

  // Function to handle saving of the edited value
  const onSave = async () => {
    if (value === initialValue) {
      setIsEditing(false)
      return
    }
    
    try {
      await meta?.onUpdate?.(row.id, column.id, value)
      setIsEditing(false)
    } catch (error) {
      console.error('Failed to update cell:', error)
      // Reset to initial value on error
      setValue(initialValue)
      setIsEditing(false)
    }
  }

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setValue(initialValue)
      setIsEditing(false)
    }
  }

  if (!editable) {
    return <div>{value}</div>
  }

  if (isEditing) {
    return (
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onSave}
        onKeyDown={handleKeyDown}
        className="m-0 h-8 w-full"
        autoFocus
      />
    )
  }

  return (
    <div 
      className={cn(
        "truncate py-2", 
        editable && "cursor-pointer hover:bg-muted/30 rounded px-2"
      )}
      onClick={() => setIsEditing(true)}
    >
      {value}
    </div>
  )
}

/**
 * Editable Select Cell - for enums and predefined options
 */
export function EditableSelectCell<TData, TValue>({
  getValue,
  row,
  column,
  table,
  options,
}: CellContext<TData, TValue> & { options: { label: string; value: string }[] }) {
  const initialValue = getValue() as string
  const [value, setValue] = React.useState(initialValue)
  
  // Check if this column is editable
  const meta = table.options.meta
  const editable = meta?.editableColumns?.includes(column.id)

  // Reset the value when the initialValue changes
  React.useEffect(() => {
    setValue(initialValue)
  }, [initialValue])

  // Function to handle saving of the edited value
  const onSave = async (newValue: string) => {
    if (newValue === initialValue) return
    
    try {
      await meta?.onUpdate?.(row.id, column.id, newValue)
      setValue(newValue)
    } catch (error) {
      console.error('Failed to update cell:', error)
      // Reset to initial value on error
      setValue(initialValue)
    }
  }

  // Find the current option label
  const currentOption = options.find((option) => option.value === value)
  const displayLabel = currentOption?.label || value

  if (!editable) {
    return <div>{displayLabel}</div>
  }

  return (
    <Select
      value={value}
      onValueChange={onSave}
    >
      <SelectTrigger className="h-8 w-full truncate border-0 bg-transparent focus:ring-transparent py-0 hover:bg-muted/30 focus:bg-muted/30">
        <SelectValue>{displayLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Editable Checkbox Cell - for boolean values
 */
export function EditableCheckboxCell<TData, TValue>({
  getValue,
  row,
  column,
  table,
}: CellContext<TData, TValue>) {
  const initialValue = getValue() as boolean
  
  // Check if this column is editable
  const meta = table.options.meta
  const editable = meta?.editableColumns?.includes(column.id)

  // Function to handle toggling of the checkbox
  const onToggle = async (checked: boolean) => {
    if (checked === initialValue) return
    
    try {
      await meta?.onUpdate?.(row.id, column.id, checked)
    } catch (error) {
      console.error('Failed to update cell:', error)
    }
  }

  if (!editable) {
    return (
      <div className="flex items-center justify-center">
        <Checkbox checked={initialValue} disabled />
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center">
      <Checkbox 
        checked={initialValue} 
        onCheckedChange={onToggle}
      />
    </div>
  )
}

/**
 * Editable Date Cell - for date values
 */
export function EditableDateCell<TData, TValue>({
  getValue,
  row,
  column,
  table,
}: CellContext<TData, TValue>) {
  const initialValue = getValue() as Date | null
  const [date, setDate] = React.useState<Date | undefined>(initialValue || undefined)
  const [isPopoverOpen, setIsPopoverOpen] = React.useState(false)
  
  // Check if this column is editable
  const meta = table.options.meta
  const editable = meta?.editableColumns?.includes(column.id)

  // Reset the date when the initialValue changes
  React.useEffect(() => {
    setDate(initialValue || undefined)
  }, [initialValue])

  // Function to handle saving of the edited date
  const onSave = async (newDate?: Date) => {
    if (newDate?.getTime() === initialValue?.getTime()) {
      setIsPopoverOpen(false)
      return
    }
    
    try {
      await meta?.onUpdate?.(row.id, column.id, newDate || null)
      setDate(newDate)
      setIsPopoverOpen(false)
    } catch (error) {
      console.error('Failed to update cell:', error)
      // Reset to initial value on error
      setDate(initialValue || undefined)
      setIsPopoverOpen(false)
    }
  }

  // Format date for display
  const formattedDate = date ? format(date, 'PPP') : 'Not set'

  if (!editable) {
    return <div>{formattedDate}</div>
  }

  return (
    <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "w-full justify-start text-left font-normal hover:bg-muted/30",
            !date && "text-muted-foreground"
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {formattedDate}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(newDate) => {
            onSave(newDate)
          }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Editable Number Cell - specifically for number inputs
 */
export function EditableNumberCell<TData, TValue>({
  getValue,
  row,
  column,
  table,
}: CellContext<TData, TValue>) {
  const initialValue = getValue() as number
  const [value, setValue] = React.useState(initialValue)
  const [isEditing, setIsEditing] = React.useState(false)

  // Check if this column is editable
  const meta = table.options.meta
  const editable = meta?.editableColumns?.includes(column.id)

  // Reset the value when the initialValue changes
  React.useEffect(() => {
    setValue(initialValue)
  }, [initialValue])

  // Function to handle saving of the edited value
  const onSave = async () => {
    if (value === initialValue) {
      setIsEditing(false)
      return
    }
    
    try {
      await meta?.onUpdate?.(row.id, column.id, value)
      setIsEditing(false)
    } catch (error) {
      console.error('Failed to update cell:', error)
      // Reset to initial value on error
      setValue(initialValue)
      setIsEditing(false)
    }
  }

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setValue(initialValue)
      setIsEditing(false)
    }
  }

  if (!editable) {
    return <div>{value}</div>
  }

  if (isEditing) {
    return (
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        onBlur={onSave}
        onKeyDown={handleKeyDown}
        className="m-0 h-8 w-full"
        autoFocus
      />
    )
  }

  return (
    <div 
      className={cn(
        "truncate py-2", 
        editable && "cursor-pointer hover:bg-muted/30 rounded px-2"
      )}
      onClick={() => setIsEditing(true)}
    >
      {value}
    </div>
  )
}

/**
 * Generic configuration for relationship cells
 */
export interface RelationshipConfig<TEntity> {
  // Service to fetch a single entity by ID
  fetchOne: (id: string) => Promise<TEntity | null>;
  // Service to fetch all entities for dropdown (only used in editable version)
  fetchAll?: () => Promise<TEntity[]>;
  // How to extract display value from the entity
  getDisplayValue: (entity: TEntity) => string;
  // How to get ID from entity (defaults to entity.id if not provided)
  getEntityId?: (entity: TEntity) => string;
  // Label to display when no entity is selected
  emptyLabel?: string;
  // Additional filter to apply to entities in dropdown
  filterEntities?: (entities: TEntity[]) => TEntity[];
}

/**
 * Generic read-only relationship cell
 * Shows related entity's display value instead of just the ID
 */
export function RelationshipCell<TData, TEntity>({
  getValue,
  row,
  column,
  table,
  relationshipConfig,
}: CellContext<TData, string> & { 
  relationshipConfig: RelationshipConfig<TEntity> 
}) {
  const meta = table.options.meta
  const tableIsReady = meta?.tableReady === true;
  
  const entityId = getValue() as string | undefined
  const [localEntityId, setLocalEntityId] = React.useState<string | undefined>(entityId)
  const [entity, setEntity] = React.useState<TEntity | null>(null)
  const [isLoadingEntity, setIsLoadingEntity] = React.useState(false)
  const [error, setError] = React.useState<Error | null>(null)
  
  // Track when entityId changes externally
  React.useEffect(() => {
    if (entityId !== localEntityId) {
      setLocalEntityId(entityId);
      setEntity(null); // Reset entity when ID changes
    }
  }, [entityId, localEntityId]);
  
  // Load entity data when ID changes
  React.useEffect(() => {
    if (!localEntityId) {
      setEntity(null)
      return
    }
    
    const loadEntity = async () => {
      setIsLoadingEntity(true)
      setError(null)
      
      try {
        const result = await relationshipConfig.fetchOne(localEntityId)
        setEntity(result)
      } catch (err) {
        console.error('Error fetching entity:', err)
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsLoadingEntity(false)
      }
    }
    
    loadEntity()
  }, [localEntityId, relationshipConfig.fetchOne])
  
  // Get the display value
  const displayValue = React.useMemo(() => {
    if (entity) {
      return relationshipConfig.getDisplayValue(entity)
    }
    
    if (localEntityId) {
      return `${relationshipConfig.emptyLabel || ''} (${localEntityId})`
    }
    
    return relationshipConfig.emptyLabel || '-'
  }, [entity, localEntityId, relationshipConfig])

  // Only show loading if table isn't ready and we're actively loading
  if (isLoadingEntity && !tableIsReady) {
    return <div className="text-muted-foreground text-xs">Loading...</div>
  }
  
  if (error) {
    return <div className="text-destructive text-xs">Error</div>
  }

  return <div>{displayValue}</div>
}

/**
 * Generic editable relationship cell
 * Shows dropdown to select related entity
 */
export function EditableRelationshipCell<TData, TEntity>({
  getValue,
  row,
  column,
  table,
  relationshipConfig,
}: CellContext<TData, string> & { 
  relationshipConfig: RelationshipConfig<TEntity> & { fetchAll: () => Promise<TEntity[]> }
}) {
  // Check if this column is editable
  const meta = table.options.meta
  const editable = meta?.editableColumns?.includes(column.id)
  
  // Get the current entity ID
  const initialEntityId = getValue() as string | null
  const [localEntityId, setLocalEntityId] = React.useState<string | undefined>(initialEntityId || undefined)
  const [currentEntity, setCurrentEntity] = React.useState<TEntity | null>(null)
  const [saveInProgress, setSaveInProgress] = React.useState(false)
  const [dropdownOpen, setDropdownOpen] = React.useState(false)
  
  // Simple relationship cache key based on column id
  const cacheKey = `relationship:${column.id}`;
  
  // Get the entity ID getter function or default to entity.id
  const getEntityId = relationshipConfig.getEntityId || ((entity: any) => entity.id)
  
  // Use the cached entities hook to manage loading and caching
  const [entities, isLoading, cacheError, refreshCache] = useCachedEntities<TEntity>(
    cacheKey,
    relationshipConfig.fetchAll
  )

  // Apply any additional filtering if provided
  const filteredEntities = React.useMemo(() => {
    return relationshipConfig.filterEntities 
      ? relationshipConfig.filterEntities(entities)
      : entities
  }, [entities, relationshipConfig.filterEntities])
  
  // If table is marked as ready, don't show initial loading states
  const tableIsReady = meta?.tableReady === true;

  // Update local state when the initialEntityId changes (e.g. from external data update)
  React.useEffect(() => {
    if (initialEntityId !== localEntityId && !saveInProgress) {
      setLocalEntityId(initialEntityId || undefined)
    }
  }, [initialEntityId, localEntityId, saveInProgress]);

  // Load entity data when ID changes or entities load
  React.useEffect(() => {
    if (!localEntityId) {
      setCurrentEntity(null)
      return
    }
    
    // First look for the entity in our list of loaded entities
    const entityFromList = filteredEntities.find(e => 
      getEntityId(e) === localEntityId
    )
    
    if (entityFromList) {
      setCurrentEntity(entityFromList)
      return
    }
    
    // If not found and we have the fetchOne function, load it directly
    const loadEntityById = async () => {
      try {
        const entity = await relationshipConfig.fetchOne(localEntityId)
        if (entity) {
          setCurrentEntity(entity)
        }
      } catch (error) {
        console.error('Failed to load entity by ID:', error)
      }
    }
    
    loadEntityById()
  }, [localEntityId, filteredEntities, relationshipConfig.fetchOne, getEntityId])

  // Refresh data when dropdown is opened
  React.useEffect(() => {
    if (dropdownOpen) {
      refreshCache();
    }
  }, [dropdownOpen, refreshCache]);

  // Function to handle saving of the edited value
  const onSave = async (newEntityId: string) => {
    if (newEntityId === localEntityId) return
    
    if (!meta?.onUpdate) {
      console.error(`Missing onUpdate handler in table meta!`)
      return
    }
    
    try {
      setSaveInProgress(true)
      
      const finalValue = newEntityId === 'none' ? null : newEntityId
      await meta.onUpdate(row.id, column.id, finalValue)
      
      // Update our local state to match the new value
      setLocalEntityId(finalValue || undefined)
      
      // Find the newly selected entity to update UI immediately
      if (newEntityId !== 'none') {
        const newEntity = filteredEntities.find(e => getEntityId(e) === newEntityId) || null
        setCurrentEntity(newEntity)
      } else {
        setCurrentEntity(null)
      }
    } catch (error) {
      console.error(`Failed to update ${column.id}:`, error)
      alert(`Failed to update: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaveInProgress(false)
    }
  }

  // Get display name for current entity
  const displayName = currentEntity 
    ? relationshipConfig.getDisplayValue(currentEntity)
    : (localEntityId ? `${relationshipConfig.emptyLabel || ''} (${localEntityId})` : (relationshipConfig.emptyLabel || '-'))

  // Only show loading state if we're actively loading, table isn't ready yet, and dropdown isn't open
  if (isLoading && !tableIsReady && !dropdownOpen) {
    return <div className="text-muted-foreground text-xs">Loading...</div>
  }
  
  if (saveInProgress) {
    return <div className="text-muted-foreground text-xs">Saving...</div>
  }

  if (!editable) {
    return <div>{displayName}</div>
  }

  return (
    <Select
      value={localEntityId || 'none'}
      onValueChange={onSave}
      disabled={saveInProgress}
      onOpenChange={setDropdownOpen}
    >
      <SelectTrigger className="h-8 w-full truncate border-0 bg-transparent focus:ring-transparent py-0 hover:bg-muted/30 focus:bg-muted/30">
        <SelectValue>{displayName}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {isLoading && (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            Loading options...
          </div>
        )}
        {!isLoading && (
          <>
            <SelectItem value="none">{relationshipConfig.emptyLabel || 'None'}</SelectItem>
            {filteredEntities.map((entity) => (
              <SelectItem key={getEntityId(entity)} value={getEntityId(entity)}>
                {relationshipConfig.getDisplayValue(entity)}
              </SelectItem>
            ))}
            {filteredEntities.length === 0 && !cacheError && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                No options available
              </div>
            )}
            {cacheError && (
              <div className="px-2 py-4 text-center text-sm text-destructive">
                Error loading options
              </div>
            )}
          </>
        )}
      </SelectContent>
    </Select>
  )
}

/**
 * Entity-agnostic cell factory for creating relationship cells
 * This replaces the hardcoded entity-specific implementations with a flexible factory approach
 */
export interface EntityConfig<TEntity> {
  // Service name in the PGlite context
  serviceName: string;
  // Function to extract display name from entity
  getDisplayValue: (entity: TEntity) => string;
  // Label to show when no entity is selected
  emptyLabel: string;
  // Optional function to get entity ID (defaults to entity.id)
  getEntityId?: (entity: TEntity) => string;
  // Optional filter for entities in dropdown
  filterEntities?: (entities: TEntity[]) => TEntity[];
}

/**
 * Factory function to create read-only entity cells for any entity type
 */
export function createEntityCell<TEntity>(entityConfig: EntityConfig<TEntity>) {
  // Return a component that can be used in table column definitions
  return function EntityCell<TData>({ ...props }: CellContext<TData, string>) {
    const { services } = usePGliteContext()
    const service = services?.[entityConfig.serviceName]
    
    if (!service) {
      return <div>{entityConfig.serviceName} service not available</div>
    }
    
    return (
      <RelationshipCell<TData, TEntity>
        {...props}
        relationshipConfig={{
          fetchOne: (id) => service.get(id),
          getDisplayValue: entityConfig.getDisplayValue,
          emptyLabel: entityConfig.emptyLabel,
          getEntityId: entityConfig.getEntityId,
          filterEntities: entityConfig.filterEntities
        }}
      />
    )
  }
}

/**
 * Factory function to create editable entity cells for any entity type
 */
export function createEditableEntityCell<TEntity>(entityConfig: EntityConfig<TEntity>) {
  // Return a component that can be used in table column definitions
  return function EditableEntityCell<TData>({ ...props }: CellContext<TData, string>) {
    const { services } = usePGliteContext()
    const service = services?.[entityConfig.serviceName]
    
    if (!service) {
      return <div>{entityConfig.serviceName} service not available</div>
    }
    
    // Create a stable fetchAll function that won't change on re-renders
    const fetchAll = React.useCallback(() => {
      return service.getAll();
    }, [service]);
    
    return (
      <EditableRelationshipCell<TData, TEntity>
        {...props}
        relationshipConfig={{
          fetchOne: (id) => service.get(id),
          fetchAll: fetchAll,
          getDisplayValue: entityConfig.getDisplayValue,
          emptyLabel: entityConfig.emptyLabel,
          getEntityId: entityConfig.getEntityId,
          filterEntities: entityConfig.filterEntities
        }}
      />
    )
  }
}

/**
 * Pre-configured entity cells for common entity types
 * These provide backward compatibility with existing code
 */

// Project cells
export const ProjectCell = createEntityCell<Project>({
  serviceName: 'projects',
  getDisplayValue: (project) => project.name,
  emptyLabel: 'No Project'
})

export const EditableProjectCell = createEditableEntityCell<Project>({
  serviceName: 'projects',
  getDisplayValue: (project) => project.name,
  emptyLabel: 'No Project'
})

// User cells
export const UserCell = createEntityCell<User>({
  serviceName: 'users',
  getDisplayValue: (user) => user.name,
  emptyLabel: 'Unassigned'
})

export const EditableUserCell = createEditableEntityCell<User>({
  serviceName: 'users',
  getDisplayValue: (user) => user.name,
  emptyLabel: 'Unassigned'
})

/**
 * Example of creating custom entity cells:
 * 
 * const TaskCell = createEntityCell<Task>({
 *   serviceName: 'tasks',
 *   getDisplayValue: (task) => task.title,
 *   emptyLabel: 'No Task'
 * })
 * 
 * const EditableTaskCell = createEditableEntityCell<Task>({
 *   serviceName: 'tasks',
 *   getDisplayValue: (task) => task.title,
 *   emptyLabel: 'No Task'
 * })
 */ 
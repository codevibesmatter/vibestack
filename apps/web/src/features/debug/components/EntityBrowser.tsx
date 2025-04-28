import { useState, useEffect, ReactNode, useCallback, memo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Table, Collection } from 'dexie';
import { db, DbUser, DbTask, DbProject, DbComment } from '../../../db/db';
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { 
  Table as UITable, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Maximum number of items to display per page
const PAGE_SIZE = 10;

// Type for database entities
type DbEntity = DbUser | DbTask | DbProject | DbComment;

export interface EntityBrowserProps<T extends DbEntity> {
  title: string;
  description: string;
  tableName: 'users' | 'tasks' | 'projects' | 'comments';
  searchFields: Array<keyof T>;
  displayFields: Array<{
    key: keyof T;
    label: string;
    render?: (value: any, item: T) => ReactNode;
  }>;
  onSelectItem: (item: T, completeData?: any) => void;
  selectedId: string | null;
}

// Helper function to fetch related data (re-introduced, simplified)
async function fetchCompleteEntityData<T extends DbEntity>(
  item: T, 
  tableName: 'users' | 'tasks' | 'projects' | 'comments'
): Promise<any> {
  let completeData: any = { ...item };
  
  // Basic type guards for safety
  const has = (prop: string) => Object.prototype.hasOwnProperty.call(item, prop);

  try {
    switch(tableName) {
      case 'tasks':
        if (has('projectId')) {
          completeData.project = await db.projects.get((item as any).projectId);
        }
        if (has('assigneeId')) {
          completeData.assignee = await db.users.get((item as any).assigneeId);
        }
        completeData.comments = await db.comments
          .where({ entityId: item.id, entityType: 'task' })
          .toArray();
        break;
        
      case 'projects':
        if (has('ownerId')) {
          completeData.owner = await db.users.get((item as any).ownerId);
        }
        completeData.tasks = await db.tasks
          .where('projectId')
          .equals(item.id)
          .toArray();
        break;
        
      case 'users':
        completeData.assignedTasks = await db.tasks
          .where('assigneeId')
          .equals(item.id)
          .toArray();
        completeData.ownedProjects = await db.projects
          .where('ownerId')
          .equals(item.id)
          .toArray();
        break;
        
      case 'comments':
        if (has('authorId')) {
          completeData.author = await db.users.get((item as any).authorId);
        }
        if (has('entityId') && has('entityType')) {
          const entityType = (item as any).entityType;
          const entityId = (item as any).entityId;
          
          if (entityType === 'task') {
            completeData.task = await db.tasks.get(entityId);
          } else if (entityType === 'project') {
            completeData.project = await db.projects.get(entityId);
          }
        }
        break;
    }
    return completeData;
    
  } catch (error) {
    console.error('Error fetching complete entity data:', error);
    return item; // Return original item as fallback if error
  }
}

function EntityBrowserInternal<T extends DbEntity>({
  title,
  description,
  tableName,
  searchFields,
  displayFields,
  onSelectItem,
  selectedId
}: EntityBrowserProps<T>) {
  // Basic state management
  const [searchQuery, setSearchQuery] = useState('');
  const [searchField, setSearchField] = useState<keyof T>(searchFields[0]);
  const [page, setPage] = useState(1);
  
  // Reset page when search changes
  useEffect(() => {
    setPage(1);
  }, [searchQuery, searchField, tableName]);
  
  // Use Dexie's useLiveQuery to efficiently get data
  const queryResult = useLiveQuery(
    async () => {
      const table = db[tableName] as Table<T, string>;
      const offset = (page - 1) * PAGE_SIZE;

      let collection: Collection<T, string>;

      // --- Query Optimization --- 
      // Prioritize indexed search with where() + startsWithIgnoreCase()
      if (searchQuery && searchField) {
        try {
          // Attempt indexed search - assumes searchField is an index
          collection = table.where(searchField as string).startsWithIgnoreCase(searchQuery);
        } catch (e) {
          // Fallback to filter if where() fails (e.g., field not indexed)
          console.warn(`Indexed search failed for field '${searchField as string}', falling back to filter.`, e);
          const lowerCaseQuery = searchQuery.toLowerCase();
          collection = table.filter((item: T) => { 
            const value = String(item[searchField] || '').toLowerCase();
            return value.includes(lowerCaseQuery);
          });
        }
      } else {
        // No search query, start with the full table
        collection = table.toCollection();
      }
      
      // Get total count *after* filtering/searching
      const totalItems = await collection.count();

      // Determine if sorting by 'updatedAt' is possible and apply query accordingly
      const sampleItem = await table.limit(1).first(); // Check on the base table
      const hasUpdatedAt = sampleItem && 'updatedAt' in sampleItem;

      let finalItems: T[];

      if (hasUpdatedAt) {
        // Apply sorting, pagination directly in the query
        finalItems = await collection
          .reverse() // Assuming descending order is desired for updatedAt
          .sortBy('updatedAt')
          .then((sortedItems: T[]) => sortedItems.slice(offset, offset + PAGE_SIZE)); // Add type for sortedItems and apply pagination after sorting
      } else {
        // No 'updatedAt' or sort failed, just paginate
        // Note: Dexie's offset/limit might be less reliable without sortBy.
        // Fetching all filtered and slicing might be safer if no sort key exists.
        // Let's try direct offset/limit first.
        try {
          finalItems = await collection.offset(offset).limit(PAGE_SIZE).toArray();
        } catch (e) {
          console.warn("Pagination without sort failed, fetching all and slicing.", e);
          const allFilteredItems = await collection.toArray();
          finalItems = allFilteredItems.slice(offset, offset + PAGE_SIZE);
        }
      }
      // --- End Query Optimization ---

      const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
      // Ensure current page doesn't exceed total pages after count is known
      const currentPage = Math.min(page, totalPages);

      return {
        items: finalItems,
        totalItems,
        totalPages,
        currentPage
      };
    },
    // Dependencies that should trigger a re-query
    [tableName, searchQuery, searchField, page]
  );
  
  // Updated selection handler: fetch data before calling parent
  const handleSelectItem = useCallback(async (item: T) => {
    // If the item is already selected, do nothing
    if (selectedId === item.id) {
      return;
    }
    
    console.time(`fetchCompleteData-${item.id}`);
    try {
      // Fetch the complete data for the selected item
      const completeData = await fetchCompleteEntityData(item, tableName);
      console.timeEnd(`fetchCompleteData-${item.id}`);
      
      // Call the parent's handler with both basic item and complete data
      onSelectItem(item, completeData); 
      
    } catch (error) { // Catch errors from fetchCompleteEntityData itself
      console.timeEnd(`fetchCompleteData-${item.id}`); // Ensure timer ends even on error
      console.error(`Failed to process selection for ${item.id}:`, error);
      // Optionally notify parent even on error, but only with basic item
      // onSelectItem(item); // Uncomment this line if you want to notify parent even if detail fetch fails
    }
    
  }, [onSelectItem, selectedId, tableName]);
  
  // Destructure with defaults for when the query is still loading
  const { 
    items = [], 
    totalItems = 0, 
    totalPages = 1, 
    currentPage = 1 
  } = queryResult || {};
  
  // Show recent items (used in quick selection UI)
  const recentItems = !searchQuery && items.length > 0 
    ? items.slice(0, Math.min(5, items.length)) 
    : null;
  
  // Don't show pagination if only one page
  const showPagination = totalPages > 1;
  
  // Loading state
  const isLoading = queryResult === undefined;
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Search UI */}
        <div className="space-y-2">
          <div className="flex items-end space-x-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="search">Search</Label>
              <Input
                id="search"
                placeholder={`Search ${title.toLowerCase()}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="w-1/3 space-y-1">
              <Label htmlFor="searchField">Field</Label>
              <Select
                value={searchField as string}
                onValueChange={(value) => setSearchField(value as keyof T)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select field" />
                </SelectTrigger>
                <SelectContent>
                  {searchFields.map((field) => (
                    <SelectItem key={field as string} value={field as string}>
                      {field as string}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button 
              variant="outline"
              onClick={() => setSearchQuery('')}
              disabled={!searchQuery}
              className="mb-px"
            >
              Clear
            </Button>
          </div>
          <div className="text-sm text-muted-foreground">
            Showing {items.length} of {totalItems} items
          </div>
        </div>
        
        {/* Recent Items */}
        {recentItems && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recent Items</h3>
            <div className="flex flex-wrap gap-2">
              {recentItems.map((item) => (
                <Button 
                  key={item.id}
                  variant="outline"
                  size="sm"
                  onClick={() => handleSelectItem(item)}
                  className={selectedId === item.id ? "border-primary" : ""}
                >
                  {String(item[displayFields[0].key]).substring(0, 20)}
                  {String(item[displayFields[0].key]).length > 20 ? '...' : ''}
                </Button>
              ))}
            </div>
          </div>
        )}
        
        {/* Data Table */}
        <div className="rounded-md border">
          <UITable>
            <TableHeader>
              <TableRow>
                {displayFields.map((field) => (
                  <TableHead key={field.key as string}>{field.label}</TableHead>
                ))}
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={displayFields.length + 1} className="text-center py-8">
                    <div className="flex justify-center">
                      <Skeleton className="h-6 w-6 rounded-full" />
                    </div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      Loading data...
                    </div>
                  </TableCell>
                </TableRow>
              )}
              
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={displayFields.length + 1} className="text-center py-8">
                    <div className="text-muted-foreground">
                      No items found
                    </div>
                    {searchQuery && (
                      <div className="mt-2">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => setSearchQuery('')}
                        >
                          Clear search
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
              
              {!isLoading && items.length > 0 && items.map((item) => {
                const isSelected = selectedId === item.id;
                return (
                  <TableRow 
                    key={item.id}
                    className={isSelected ? "bg-muted/50" : ""}
                    onClick={() => handleSelectItem(item)}
                    style={{ cursor: 'pointer' }}
                  >
                    {displayFields.map((field) => (
                      <TableCell key={`${item.id}-${field.key as string}`}>
                        {field.render 
                          ? field.render(item[field.key], item)
                          : String(item[field.key] || '')}
                      </TableCell>
                    ))}
                    <TableCell>
                      <Button 
                        variant="outline"
                        size="sm" 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectItem(item);
                        }}
                      >
                        {isSelected ? 'Selected' : 'Select'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </UITable>
        </div>
        
        {/* Pagination */}
        {showPagination && (
          <div className="flex justify-center items-center gap-2 mt-4">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              Previous
            </Button>
            
            <span>
              Page {currentPage} of {totalPages}
            </span>
            
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Export with memo for basic memoization
// Explicitly type the memoized component to retain generic information
export const EntityBrowser = memo(EntityBrowserInternal) as <T extends DbEntity>(
  props: EntityBrowserProps<T>
) => React.ReactElement; 
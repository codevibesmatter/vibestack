import { useState, useEffect, useCallback, useRef } from 'react';
import { getDatabase, Results } from '@/db/db';
// import { PGliteQueryBuilder } from '../typeorm/PGliteQueryBuilder'; // REMOVED - Use standard TypeORM QB
import { SelectQueryBuilder, ObjectLiteral } from 'typeorm'; // Import standard SelectQueryBuilder & ObjectLiteral

// Define the QueryState interface locally
interface QueryState<T> {
  data: T[] | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Helper function to transform snake_case database fields to camelCase TypeScript objects.
 * This handles both direct fields and prefixed fields (like task_id -> id).
 */
function transformDatabaseResultToEntity<T extends ObjectLiteral>(
  row: Record<string, any>,
  entityName: string
): T {
  const result: Record<string, any> = {};
  const entityPrefix = entityName.toLowerCase() + '_';
  
  // Process each field in the row
  for (const key in row) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      
      // Handle prefixed fields (e.g., task_id -> id)
      if (key.startsWith(entityPrefix)) {
        // Convert snake_case to camelCase and remove prefix
        const unprefixedKey = key.substring(entityPrefix.length);
        const camelCaseKey = unprefixedKey.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        result[camelCaseKey] = value;
      } else {
        // Handle non-prefixed fields (direct snake_case to camelCase)
        const camelCaseKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        result[camelCaseKey] = value;
      }
    }
  }
  
  return result as T;
}

/**
 * React hook for executing a query using TypeORM's query builder and automatically
 * updating when underlying data changes.
 * Uses PGlite's live query functionality to handle real-time updates.
 */
export function useLiveEntity<T extends ObjectLiteral & { id: string; updatedAt?: Date | string; createdAt?: Date | string }>(
  queryBuilder: SelectQueryBuilder<T> | null,
  options?: {
    enabled?: boolean;
    transform?: boolean; // Add option to control transformation
  }
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({
    data: null,
    loading: options?.enabled !== false && !!queryBuilder,
    error: null
  });

  const unsubscribeRef = useRef<(() => Promise<void>) | null>(null);
  const enabled = !!queryBuilder && options?.enabled !== false;
  const shouldTransform = options?.transform !== false; // Default to true if not specified

  // Extract entity name from query builder for transformation
  const entityName = queryBuilder?.expressionMap.mainAlias?.name || '';

  // Effect to set up the live query
  useEffect(() => {
    if (!enabled || !queryBuilder) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    let isMounted = true;
    console.log('[useLiveEntity] Setting up live query with PGlite...');

    const setupLiveQuery = async () => {
      try {
        // First set loading state
        if (isMounted) {
          setState(prev => ({ ...prev, loading: true, error: null }));
        }

        const db = await getDatabase();
        
        // Check if the live extension is available
        if (!db.live || !db.live.query) {
          throw new Error('PGlite live query extension is not available');
        }

        console.log('[useLiveEntity] Database instance obtained with live query support');
        
        // Get the SQL and parameters from the query builder
        const [sql, params] = queryBuilder.getQueryAndParameters();
        console.log('[useLiveEntity] Watching SQL:', sql, 'with params:', params);

        // Set up the live query
        const liveQueryResult = await db.live.query(sql, params, (results: Results<any>) => {
          console.log('[useLiveEntity] Live query update received:', results);
          
          if (isMounted) {
            // Format and transform the results
            let formattedResults = results.rows || [];
            
            // Apply transformation if enabled
            if (shouldTransform && entityName) {
              console.log('[useLiveEntity] Transforming snake_case to camelCase entities');
              formattedResults = formattedResults.map((row: Record<string, any>) => 
                transformDatabaseResultToEntity<T>(row, entityName)
              );
            }
            
            console.log('[useLiveEntity] Processed results:', formattedResults.length, 'rows');
            
            setState(prev => {
              // Only update if the data has actually changed
              const stringifiedNew = JSON.stringify(formattedResults);
              const stringifiedOld = JSON.stringify(prev.data);
              
              if (stringifiedNew !== stringifiedOld) {
                console.log('[useLiveEntity] Data changed, updating state');
                return { data: formattedResults, loading: false, error: null };
              }
              console.log('[useLiveEntity] No changes in data');
              return { ...prev, loading: false };
            });
          }
        });

        // Store the unsubscribe function
        unsubscribeRef.current = liveQueryResult.unsubscribe;
        
        // Set the initial results if we have them
        if (isMounted && liveQueryResult.initialResults?.rows) {
          console.log('[useLiveEntity] Setting initial results:', liveQueryResult.initialResults.rows.length, 'rows');
          
          // Apply transformation to initial results if enabled
          let initialResults = liveQueryResult.initialResults.rows;
          
          if (shouldTransform && entityName) {
            console.log('[useLiveEntity] Transforming initial results from snake_case to camelCase');
            initialResults = initialResults.map((row: Record<string, any>) => 
              transformDatabaseResultToEntity<T>(row, entityName)
            );
          }
          
          setState({ 
            data: initialResults, 
            loading: false, 
            error: null 
          });
        }
        
        console.log('[useLiveEntity] Live query setup complete');
      } catch (error) {
        console.error('[useLiveEntity] Error setting up live query:', error);
        
        if (isMounted) {
          setState({ 
            data: null, 
            loading: false, 
            error: error instanceof Error ? error : new Error(String(error)) 
          });
          
          // Fall back to a regular query if live query fails
          try {
            console.log('[useLiveEntity] Falling back to regular query');
            const entities = await queryBuilder.getMany();
            
            if (isMounted) {
              setState({ data: entities, loading: false, error: null });
            }
          } catch (fallbackError) {
            console.error('[useLiveEntity] Fallback query failed:', fallbackError);
            if (isMounted) {
              setState({ 
                data: null, 
                loading: false, 
                error: fallbackError instanceof Error 
                  ? fallbackError 
                  : new Error(String(fallbackError)) 
              });
            }
          }
        }
      }
    };

    setupLiveQuery();

    // Cleanup: unsubscribe from live query
    return () => {
      isMounted = false;
      
      if (unsubscribeRef.current) {
        console.log('[useLiveEntity] Unsubscribing from live query');
        unsubscribeRef.current().catch(err => {
          console.error('[useLiveEntity] Error unsubscribing from live query:', err);
        });
        unsubscribeRef.current = null;
      }
    };
  }, [enabled, shouldTransform, entityName, queryBuilder && queryBuilder.getSql(), JSON.stringify(queryBuilder?.getParameters())]);
  
  return state;
} 
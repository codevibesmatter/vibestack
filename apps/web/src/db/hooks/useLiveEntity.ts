import { useState, useEffect, useCallback } from 'react';
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
 * React hook for executing a query using TypeORM's query builder and automatically
 * updating when underlying data changes.
 * Uses PGlite's `live.incrementalQuery` if a `keyColumn` is provided for efficiency,
 * otherwise falls back to `live.query` which triggers a full refetch.
 */
export function useLiveEntity<T extends ObjectLiteral & { id: string; updated_at?: Date | string; created_at?: Date | string }>(
  queryBuilder: SelectQueryBuilder<T> | null,
  options?: {
    enabled?: boolean;
    /** If provided, uses efficient `live.incrementalQuery` with this column as the key. */
    keyColumn?: string;
  }
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({
    data: null,
    loading: options?.enabled !== false && !!queryBuilder,
    error: null
  });
  // State to trigger refetches (only used for non-incremental fallback)
  const [refetchCounter, setRefetchCounter] = useState(0);

  const enabled = !!queryBuilder && options?.enabled !== false;
  const keyColumn = options?.keyColumn;

  // --- Effect for Fetching Data with TypeORM --- 
  useEffect(() => {
    const fetchData = async () => {
      if (!enabled || !queryBuilder) {
        setState({ data: null, loading: false, error: null });
        return;
      }

      console.log('[useLiveEntity Fetching] Running queryBuilder.getMany()...');
      // Ensure state type matches QueryState<T>
      setState((prev: QueryState<T>) => ({ ...prev, loading: true, error: null }));

      try {
        const entities = await queryBuilder.getMany();
        console.log(`[useLiveEntity Fetching] Success, fetched ${entities?.length ?? 0} entities.`);

        // Ensure state type matches QueryState<T>
        setState((prevState) => {
          // Memoization check still useful for initial load
          if (JSON.stringify(prevState.data) !== JSON.stringify(entities)) {
            return { data: entities, loading: false, error: null };
          }
          return { ...prevState, loading: false, error: null };
        });
      } catch (error) {
        console.error('[useLiveEntity Fetching] Error executing queryBuilder:', error);
        // Ensure state type matches QueryState<T>
        setState({ data: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) });
      }
    };

    fetchData();
    // Dependencies: include refetchCounter to trigger refetch ONLY IF not using keyColumn
  }, [enabled, queryBuilder?.getSql(), JSON.stringify(queryBuilder?.getParameters()), keyColumn ? null : refetchCounter]); // Add keyColumn check

  // --- Effect for Setting up PGlite Live Query Listener --- 
  useEffect(() => {
    let unsubscribe: (() => Promise<void>) | undefined;
    let isInitialUpdate = true;

    const setupLiveQueryListener = async () => {
      if (!enabled || !queryBuilder) return;

      const listenerType = keyColumn ? 'incrementalQuery' : 'query';
      console.log(`[useLiveEntity Listener] Setting up PGlite ${listenerType} listener...`);
      
      try {
        const db = await getDatabase();
        const [sql, params] = queryBuilder.getQueryAndParameters();

        if (keyColumn && !db.live?.incrementalQuery) {
          throw new Error(`Live query function (incrementalQuery) not available on database instance.`);
        } else if (!keyColumn && !db.live?.query) {
          throw new Error(`Live query function (query) not available on database instance.`);
        }
        
        console.log(`[useLiveEntity Listener] Watching SQL:`, { sql, params, keyColumn });

        // Handler for incremental updates (updates state directly)
        const handleIncrementalUpdate = (res: Results<T>) => {
          console.log(`[useLiveEntity Listener (${listenerType})] Received update.`, res);
          if (isInitialUpdate) {
            console.log(`[useLiveEntity Listener (${listenerType})] Skipping initial update notification.`);
            isInitialUpdate = false;
            return;
          }
          // Directly update state with incremental results
          console.log(`[useLiveEntity Listener (${listenerType})] Updating state directly with ${res?.rows?.length ?? 0} rows.`);
          setState((prevState) => {
            // Simple replacement, assumes incremental query returns the desired state
            if (JSON.stringify(prevState.data) !== JSON.stringify(res.rows)) {
               return { data: res.rows, loading: false, error: null };
            }
            return prevState; // No change detected
          });
        };

        // Handler for basic updates (triggers refetch)
        const handleBasicUpdate = (res: Results<T>) => {
          console.log(`[useLiveEntity Listener (${listenerType})] Received update notification.`, res);
          if (isInitialUpdate) {
            console.log(`[useLiveEntity Listener (${listenerType})] Skipping initial update notification.`);
            isInitialUpdate = false;
            return;
          }
          // Trigger refetch by incrementing the counter
          console.log(`[useLiveEntity Listener (${listenerType})] Triggering refetch via counter increment...`);
          setRefetchCounter(count => count + 1);
        };

        let liveQueryReturn;
        if (keyColumn && db.live?.incrementalQuery) {
           liveQueryReturn = await db.live.incrementalQuery(sql, params, keyColumn, handleIncrementalUpdate);
        } else if (db.live?.query) {
           liveQueryReturn = await db.live.query(sql, params, handleBasicUpdate);
        } else {
           // Should be caught by checks above, but safety net
           throw new Error("Suitable live query function not found.");
        }

        unsubscribe = liveQueryReturn.unsubscribe;
        console.log(`[useLiveEntity Listener (${listenerType})] Listener setup complete.`);

      } catch (error) {
        console.error('[useLiveEntity Listener] Error setting up listener:', error);
        // Set error state if listener fails
        setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error : new Error(String(error)) }));
      }
    };

    setupLiveQueryListener();
    
    return () => {
      if (unsubscribe) {
        console.log(`[useLiveEntity Listener] Unsubscribing (${keyColumn ? 'incrementalQuery' : 'query'})...`);
        unsubscribe().catch(err => console.error('[useLiveEntity Listener] Error unsubscribing:', err));
      }
    };
    // Dependencies: include keyColumn
  }, [enabled, queryBuilder?.getSql(), JSON.stringify(queryBuilder?.getParameters()), keyColumn]);
  
  // Ensure return state type matches QueryState<T>
  return state;
} 
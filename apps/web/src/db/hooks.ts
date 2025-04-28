/**
 * React Hooks for PGlite
 * 
 * This file provides React hooks for interacting with the PGlite database.
 */

import { useState, useEffect } from 'react';
import { getDatabase, PGliteWithLive, QueryState, Results } from './db';

/**
 * React hook for executing a SQL query
 */
export function useQuery<T = any>(
  sql: string, 
  params: any[] = [], 
  options?: { enabled?: boolean }
): QueryState<T[]> {
  const [state, setState] = useState<QueryState<T[]>>({
    data: null,
    loading: true,
    error: null
  });
  
  const enabled = options?.enabled !== false;
  
  useEffect(() => {
    if (!sql || !enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    
    let mounted = true;
    
    async function executeQuery() {
      try {
        setState(prev => ({ ...prev, loading: true }));
        
        const db = await getDatabase();
        const results = await db.query(sql, params);
        
        if (mounted) {
          // Handle PGlite results type correctly
          const formattedResults = Array.isArray(results) 
            ? results as unknown as T[] 
            : ([] as T[]);
          
          setState({
            data: formattedResults,
            loading: false,
            error: null
          });
        }
      } catch (error) {
        console.error('Error executing query:', error);
        
        if (mounted) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }
    }
    
    executeQuery();
    
    return () => {
      mounted = false;
    };
  }, [sql, JSON.stringify(params), enabled]);
  
  return state;
}

/**
 * React hook for executing a mutation query (INSERT, UPDATE, DELETE)
 */
export function useMutation<T = any>(
  sql?: string
): [
  (params?: any[]) => Promise<T[]>,
  { loading: boolean; error: Error | null; data: T[] | null }
] {
  const [state, setState] = useState<{
    loading: boolean;
    error: Error | null;
    data: T[] | null;
  }>({
    loading: false,
    error: null,
    data: null
  });
  
  const executeMutation = async (params: any[] = []) => {
    try {
      setState(prev => ({ ...prev, loading: true }));
      
      const db = await getDatabase();
      const result = await db.query(sql || '', params);
      
      // Handle PGlite results type correctly
      const formattedResults = Array.isArray(result) 
        ? result as unknown as T[] 
        : ([] as T[]);
      
      setState({
        loading: false,
        error: null,
        data: formattedResults
      });
      
      return formattedResults;
    } catch (error) {
      console.error('Error executing mutation:', error);
      
      const errorObj = error instanceof Error 
        ? error 
        : new Error(String(error));
      
      setState({
        loading: false,
        error: errorObj,
        data: null
      });
      
      throw errorObj;
    }
  };
  
  return [executeMutation, state];
}

/**
 * Simplistic live query implementation
 * Note: This is a basic implementation that doesn't actually
 * use server-sent events or websockets. It polls for changes.
 */
export function useLive<T = any>(
  sql: string,
  params: any[] = [],
  options?: { pollingInterval?: number; enabled?: boolean }
): QueryState<T[]> {
  const [state, setState] = useState<QueryState<T[]>>({
    data: null,
    loading: true,
    error: null
  });
  
  const pollingInterval = options?.pollingInterval || 2000;
  const enabled = options?.enabled !== false;
  
  useEffect(() => {
    if (!sql || !enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    
    let mounted = true;
    let intervalId: NodeJS.Timeout;
    
    async function executeLiveQuery() {
      try {
        if (!mounted) return;
        
        setState(prev => ({ ...prev, loading: true }));
        
        const db = await getDatabase();
        
        // If db.live exists and has a query method, use it
        if (db.live?.query) {
          try {
            const { results } = await db.live.query(sql, params);
            
            if (mounted) {
              // Handle PGlite results type correctly
              const formattedResults = Array.isArray(results) 
                ? results as unknown as T[] 
                : ([] as T[]);
              
              setState({
                data: formattedResults,
                loading: false,
                error: null
              });
            }
          } catch (error) {
            console.error('Error executing live query:', error);
            // Fallback to regular query if live query fails
            const results = await db.query(sql, params);
            
            if (mounted) {
              // Handle PGlite results type correctly
              const formattedResults = Array.isArray(results) 
                ? results as unknown as T[] 
                : ([] as T[]);
              
              setState({
                data: formattedResults,
                loading: false,
                error: null
              });
            }
          }
        } else {
          // Fallback to regular query
          const results = await db.query(sql, params);
          
          if (mounted) {
            // Handle PGlite results type correctly
            const formattedResults = Array.isArray(results) 
              ? results as unknown as T[] 
              : ([] as T[]);
            
            setState({
              data: formattedResults,
              loading: false,
              error: null
            });
          }
        }
      } catch (error) {
        console.error('Error in live query:', error);
        
        if (mounted) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }
    }
    
    // Execute immediately
    executeLiveQuery();
    
    // Set up polling interval
    intervalId = setInterval(executeLiveQuery, pollingInterval);
    
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [sql, JSON.stringify(params), pollingInterval, enabled]);
  
  return state;
} 
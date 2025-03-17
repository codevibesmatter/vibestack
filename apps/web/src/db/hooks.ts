/**
 * Database Hooks
 * 
 * This module provides React hooks for interacting with the database
 * through the message bus.
 */

import { useState, useEffect, useCallback } from 'react';
import { dbMessageBus, DbEventType } from './message-bus';

/**
 * Hook for executing a database query
 * @returns An object with query functions and state
 */
export function useDbQuery() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  /**
   * Execute a SQL query
   * @param sql The SQL query
   * @param params The query parameters
   * @returns A promise that resolves with the query result
   */
  const executeQuery = useCallback(async <T = any>(sql: string, params?: any[]): Promise<T> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await dbMessageBus.sendCommand<T>('query', { sql, params });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error executing query');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  return {
    executeQuery,
    isLoading,
    error
  };
}

/**
 * Hook for subscribing to database events
 * @param eventType The event type to subscribe to
 * @param callback The callback function
 */
export function useDbEvent(eventType: DbEventType, callback: (data: any) => void) {
  useEffect(() => {
    // Subscribe to event
    const unsubscribe = dbMessageBus.subscribe(eventType, callback);
    
    // Unsubscribe on cleanup
    return unsubscribe;
  }, [eventType, callback]);
}

/**
 * Hook for managing entities
 * @returns An object with entity management functions and state
 */
export function useDbEntity() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  /**
   * Upsert an entity
   * @param entityType The entity type
   * @param entityId The entity ID
   * @param data The entity data
   * @param timestamp The timestamp
   * @returns A promise that resolves with the upsert result
   */
  const upsertEntity = useCallback(async <T = any>(
    entityType: string,
    entityId: string,
    data: any,
    timestamp?: number
  ): Promise<T> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await dbMessageBus.sendCommand<T>('upsert', {
        entityType,
        entityId,
        data,
        timestamp: timestamp || Date.now()
      });
      
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error upserting entity');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  /**
   * Delete an entity
   * @param entityType The entity type
   * @param entityId The entity ID
   * @param timestamp The timestamp
   * @returns A promise that resolves with the delete result
   */
  const deleteEntity = useCallback(async <T = any>(
    entityType: string,
    entityId: string,
    timestamp?: number
  ): Promise<T> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await dbMessageBus.sendCommand<T>('delete', {
        entityType,
        entityId,
        timestamp: timestamp || Date.now()
      });
      
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error deleting entity');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  return {
    upsertEntity,
    deleteEntity,
    isLoading,
    error
  };
}

/**
 * Hook for executing database transactions
 * @returns An object with transaction functions and state
 */
export function useDbTransaction() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  /**
   * Execute a transaction
   * @param operations The operations to execute
   * @returns A promise that resolves with the transaction result
   */
  const executeTransaction = useCallback(async <T = any>(operations: any[]): Promise<T> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await dbMessageBus.sendCommand<T>('transaction', { operations });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error executing transaction');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  return {
    executeTransaction,
    isLoading,
    error
  };
}

/**
 * Hook for tracking database initialization status
 * @returns The database initialization status
 */
export function useDbStatus() {
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    // Check if already initialized
    const checkInitialized = async () => {
      try {
        // Try to execute a simple query to check if initialized
        await dbMessageBus.sendCommand('query', { sql: 'SELECT 1' });
        setIsInitialized(true);
      } catch (err) {
        // Ignore error - we'll wait for initialization event
      }
    };
    
    checkInitialized();
    
    // Subscribe to initialization event
    const unsubscribeInit = dbMessageBus.subscribe('initialized', () => {
      setIsInitialized(true);
      setError(null);
    });
    
    // Subscribe to error event
    const unsubscribeError = dbMessageBus.subscribe('error', (data) => {
      setError(data.error);
    });
    
    // Unsubscribe on cleanup
    return () => {
      unsubscribeInit();
      unsubscribeError();
    };
  }, []);
  
  return {
    isInitialized,
    error
  };
} 
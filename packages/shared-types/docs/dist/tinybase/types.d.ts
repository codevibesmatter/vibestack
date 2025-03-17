import type { Store, Row, DoRollback } from 'tinybase';
import type { ErrorMetrics, TypeErrorCategory } from '../error/types';
import type { TableName } from './core/store';
/**
 * TinyBase store instance with its configuration
 */
export interface TinybaseInstance {
    store: Store;
    persister: any;
    errorHandler: ErrorHandler;
    syncManager: SyncManager;
}
/**
 * TinyBase store error handler
 */
export interface ErrorHandler {
    trackError(error: Error, context: string, metadata?: Record<string, any>): void;
    trackValidationError(category: typeof TypeErrorCategory, operation: string, details: Record<string, any>): void;
    getMetrics(): ErrorMetrics;
    resetMetrics(): void;
}
/**
 * TinyBase sync manager
 */
export interface SyncManager {
    handleConnection(ws: WebSocket, id: string): void;
    getConnectionCount(): number;
    getConnections(): string[];
    stopPingInterval(): void;
}
/**
 * TinyBase store methods
 */
export interface TinybaseStoreMethods {
    getStore(): Store;
    getTables(): Partial<Record<TableName, Record<string, Row>>>;
    getTable(tableId: TableName): Record<string, Row>;
    getRow(tableId: TableName, rowId: string): Row | null;
    setRow(tableId: TableName, rowId: string, data: Row): void;
    deleteRow(tableId: TableName, rowId: string): void;
    addListener(tableId: TableName, callback: () => void): () => void;
    getRowCount(tableId: TableName): number;
    hasTable(tableId: TableName): boolean;
    hasTables(): boolean;
    getTableIds(): TableName[];
}
/**
 * TinyBase store rollback handler
 */
export type RollbackHandler = DoRollback;
/**
 * TinyBase store health check response
 */
export interface StoreHealthCheck {
    status: 'ok' | 'error';
    tables: TableName[];
    initialized: boolean;
    stats: {
        users: number;
        projects: number;
        tasks: number;
    };
}
/**
 * TinyBase store debug metrics
 */
export interface StoreDebugMetrics {
    store: {
        tables: TableName[];
        rowCounts: {
            users: number;
            projects: number;
            tasks: number;
        };
    };
    errors: ErrorMetrics;
    websocket: {
        connections: number;
        clients: string[];
    };
}

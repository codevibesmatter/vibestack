import type { TableName, TableRecord } from '../core/store';
import type { StoreOperation } from './crud';
/**
 * Store transaction
 */
export interface StoreTransaction {
    id: string;
    operations: StoreOperation[];
    timestamp: number;
    userId?: string;
    metadata?: Record<string, unknown>;
}
/**
 * Store subscription
 */
export interface StoreSubscription<T extends TableName = TableName> {
    id: string;
    table: T;
    filter?: Partial<TableRecord<T>>;
    callback: (operation: StoreOperation<T>) => void;
    userId?: string;
    createdAt: number;
}

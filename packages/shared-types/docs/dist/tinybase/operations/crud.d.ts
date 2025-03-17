import type { TableName, TableRecord } from '../core/store';
/**
 * Store operation type
 */
export type OperationType = 'create' | 'update' | 'delete';
/**
 * Store operation
 */
export interface StoreOperation<T extends TableName = TableName> {
    table: T;
    type: OperationType;
    id: string;
    data?: TableRecord<T>;
    timestamp: number;
    userId?: string;
}
/**
 * Store query options
 */
export interface StoreQueryOptions<T extends TableName> {
    table: T;
    filter?: Partial<TableRecord<T>>;
    sort?: {
        field: keyof TableRecord<T>;
        order: 'asc' | 'desc';
    };
    limit?: number;
    offset?: number;
}
/**
 * Store query result
 */
export interface StoreQueryResult<T extends TableName> {
    records: TableRecord<T>[];
    total: number;
    hasMore: boolean;
}

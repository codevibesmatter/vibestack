import type { TableName } from '../core/store';
/**
 * Store metrics
 */
export interface StoreMetrics {
    tables: Record<TableName, {
        totalRecords: number;
        lastModified: number;
    }>;
    transactions: {
        total: number;
        lastHour: number;
        lastDay: number;
    };
    subscriptions: {
        active: number;
        byTable: Record<TableName, number>;
    };
}

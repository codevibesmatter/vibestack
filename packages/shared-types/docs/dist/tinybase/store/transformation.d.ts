import type { Row } from 'tinybase';
import type { BaseSchema } from '../../domain/schemas/base';
import type { ValidationHandler } from './validation';
type StoreData = Record<string, string | number | boolean | null>;
export declare class TransformationHandler<T extends BaseSchema> {
    private validationHandler;
    constructor(validationHandler: ValidationHandler<T>);
    toRow(data: T, context: {
        operation: string;
        table: string;
        start: number;
    }): Row;
    fromRow(data: StoreData, context: {
        operation: string;
        table: string;
        start: number;
    }): T;
    fromTable(table: Record<string, StoreData>, context: {
        operation: string;
        table: string;
        start: number;
    }): Record<string, T>;
}
export {};

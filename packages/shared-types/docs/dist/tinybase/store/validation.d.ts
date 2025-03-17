import { z } from 'zod';
import type { SerializationOptions } from '../../serialization/core/types';
import { TypeSafetyTracker } from '../../error/tracking';
import type { BaseSchema } from '../../domain/schemas/base';
type StoreData = Record<string, string | number | boolean | null>;
export declare class ValidationHandler<T extends BaseSchema> {
    private schema;
    private errorTracker;
    private options;
    constructor(schema: z.ZodSchema<T>, errorTracker: TypeSafetyTracker, options?: SerializationOptions);
    validateData(data: StoreData, context: {
        operation: string;
        table: string;
        start: number;
    }): T;
    private createValidationError;
    private handleValidationError;
    handleRuntimeError(error: unknown, context: {
        operation: string;
        table: string;
        data?: unknown;
        start: number;
    }): void;
}
export {};

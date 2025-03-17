import type { BaseSchema } from '../../domain/schemas';
import type { StoreData } from './types';
/**
 * Convert a domain object to TinyBase store format
 */
export declare function toTinyBase<T extends BaseSchema>(data: T): StoreData;
/**
 * Convert TinyBase store data back to domain object
 */
export declare function fromTinyBase<T extends BaseSchema>(data: StoreData): Partial<T>;
export * from './types';

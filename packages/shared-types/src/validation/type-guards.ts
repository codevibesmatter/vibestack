import { z } from 'zod';
import type { User, Project, Task } from '@repo/db';

/**
 * Type guard for errors
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Type guard for plain objects
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard for checking if an object has a property
 */
export function hasProperty<K extends string>(obj: unknown, key: K): obj is { [P in K]: unknown } {
  return isPlainObject(obj) && key in obj;
}

/**
 * Type guard for user data
 */
export function isUserData(data: unknown): data is User {
  return isPlainObject(data) && 'email' in data;
}

/**
 * Type guard for project data
 */
export function isProjectData(data: unknown): data is Project {
  return isPlainObject(data) && 'name' in data;
}

/**
 * Type guard for task data
 */
export function isTaskData(data: unknown): data is Task {
  return isPlainObject(data) && 'title' in data;
}

/**
 * Create a type guard function for a Zod schema
 */
export function createTypeGuard<T>(schema: z.ZodSchema<T>) {
  return (data: unknown): data is T => schema.safeParse(data).success;
}

/**
 * Type guard for checking if a value is a Record of a specific type
 */
export function isRecordOf<T>(value: unknown, itemGuard: (item: unknown) => item is T): value is Record<string, T> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(itemGuard);
}

// Create type guards for each schema
export const createUserGuard = () => createTypeGuard(DomainSchema.User);
export const createProjectGuard = () => createTypeGuard(DomainSchema.Project);
export const createTaskGuard = () => createTypeGuard(DomainSchema.Task);

// Cloudflare-specific bindings type guards
export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return isPlainObject(value) && 'idFromName' in value && 'get' in value;
}

export function isKVNamespace(value: unknown): value is KVNamespace {
  return isPlainObject(value) && 'get' in value && 'put' in value;
}

export function isR2Bucket(value: unknown): value is R2Bucket {
  return isPlainObject(value) && 'get' in value && 'put' in value;
}

export function isD1Database(value: unknown): value is D1Database {
  return isPlainObject(value) && 'prepare' in value && 'batch' in value;
}

export function isFetcher(value: unknown): value is Fetcher {
  return isPlainObject(value) && 'fetch' in value;
}

export function isQueue(value: unknown): value is Queue {
  return isPlainObject(value) && 'send' in value;
} 
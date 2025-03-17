/**
 * PostgreSQL JSON compatible types
 */
export type PostgresJsonValue = string | number | boolean | null | PostgresJsonArray | PostgresJsonObject;

export interface PostgresJsonObject {
  [key: string]: PostgresJsonValue;
}

export interface PostgresJsonArray extends Array<PostgresJsonValue> {} 
import type { QueryResultRow } from '@neondatabase/serverless';

export interface DatabaseContext {
  env: {
    DATABASE_URL: string;
  };
}

export interface DatabaseService {
  findOne<T extends QueryResultRow>(tableName: string, where: object): Promise<T | null>;
  find<T extends QueryResultRow>(tableName: string, where?: object): Promise<T[]>;
  insert<T extends QueryResultRow>(tableName: string, data: Partial<T>): Promise<T>;
  update<T extends QueryResultRow>(tableName: string, where: object, data: Partial<T>): Promise<T[]>;
  delete(tableName: string, where: object): Promise<number>;
  createQueryBuilder(tableName: string, alias?: string): QueryBuilder;
}

export interface QueryBuilder {
  // Basic query methods
  select(columns?: string | string[]): this;
  where(condition: string | object): this;
  andWhere(condition: string | object): this;
  orWhere(condition: string | object): this;
  orderBy(column: string, direction: 'ASC' | 'DESC'): this;
  addOrderBy(column: string, direction: 'ASC' | 'DESC'): this;
  skip(skip: number): this;
  take(take: number): this;
  limit(limit: number): this;
  offset(offset: number): this;

  // Join methods
  leftJoin(table: string, alias: string, condition: string): this;
  innerJoin(table: string, alias: string, condition: string): this;
  leftJoinAndSelect(property: string, alias: string, condition?: string, parameters?: any): this;
  innerJoinAndSelect(property: string, alias: string, condition?: string, parameters?: any): this;

  // Grouping methods
  groupBy(column: string): this;
  having(condition: string, parameters?: any): this;

  // Execution methods
  execute<T extends QueryResultRow = QueryResultRow>(): Promise<T[]>;
  executeSingle<T extends QueryResultRow = QueryResultRow>(): Promise<T | null>;
  getRawMany<T extends QueryResultRow = QueryResultRow>(): Promise<T[]>;
  getRawOne<T extends QueryResultRow = QueryResultRow>(): Promise<T | null>;
  getMany<T extends QueryResultRow = QueryResultRow>(): Promise<T[]>;
  getOne<T extends QueryResultRow = QueryResultRow>(): Promise<T | null>;
  getSql(): string;
} 
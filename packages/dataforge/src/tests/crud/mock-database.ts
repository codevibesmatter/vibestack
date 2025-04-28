import type { DatabaseService, QueryBuilder } from '../../types/database.js';
import type { QueryResultRow } from '@neondatabase/serverless';
import { randomUUID } from 'crypto';

interface MockData {
  [key: string]: any[];
}

interface Join {
  type: 'LEFT' | 'INNER';
  table: string;
  alias: string;
  condition: string;
}

export class MockQueryBuilder implements QueryBuilder {
  private selectedFields: string[] = ['*'];
  private conditions: string[] = [];
  private joins: Join[] = [];
  private groupByFields: string[] = [];
  private havingConditions: string[] = [];
  private orderByFields: string[] = [];
  private limitValue?: number;
  private offsetValue?: number;
  private tableName: string;
  private data: MockData;
  private alias: string;

  constructor(tableName: string, data: MockData, alias?: string) {
    this.tableName = tableName;
    this.data = data;
    this.alias = alias || tableName;
  }

  select(fields: string[]): this {
    this.selectedFields = fields;
    return this;
  }

  where(condition: string): this {
    this.conditions.push(condition);
    return this;
  }

  andWhere(condition: string): this {
    this.conditions.push(`AND ${condition}`);
    return this;
  }

  orWhere(condition: string): this {
    this.conditions.push(`OR ${condition}`);
    return this;
  }

  orderBy(field: string, direction: 'ASC' | 'DESC'): this {
    this.orderByFields.push(`${field} ${direction}`);
    return this;
  }

  addOrderBy(field: string, direction: 'ASC' | 'DESC'): this {
    this.orderByFields.push(`${field} ${direction}`);
    return this;
  }

  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  offset(value: number): this {
    this.offsetValue = value;
    return this;
  }

  leftJoin(property: string, alias: string, condition?: string): this {
    const [ownerAlias, relatedProperty] = property.split('.');
    if (!relatedProperty) return this;
    
    const tableName = this.pluralize(relatedProperty);
    const joinCondition = condition || `${ownerAlias}.id = ${alias}.${ownerAlias}Id`;
    this.joins.push({ type: 'LEFT', table: tableName, alias, condition: joinCondition });
    return this;
  }

  innerJoin(property: string, alias: string, condition?: string): this {
    const [ownerAlias, relatedProperty] = property.split('.');
    if (!relatedProperty) return this;
    
    const tableName = this.pluralize(relatedProperty);
    const joinCondition = condition || `${ownerAlias}.id = ${alias}.${ownerAlias}Id`;
    this.joins.push({ type: 'INNER', table: tableName, alias, condition: joinCondition });
    return this;
  }

  leftJoinAndSelect(property: string, alias: string, condition?: string): this {
    return this.leftJoin(property, alias, condition);
  }

  innerJoinAndSelect(property: string, alias: string, condition?: string): this {
    return this.innerJoin(property, alias, condition);
  }

  groupBy(column: string): this {
    this.groupByFields = [column];
    return this;
  }

  having(condition: string): this {
    this.havingConditions.push(condition);
    return this;
  }

  private pluralize(word: string): string {
    // Simple pluralization for our use case
    return word.endsWith('s') ? word : `${word}s`;
  }

  private evaluateCondition(condition: string, item: any): boolean {
    // Simple condition evaluation for common patterns
    if (condition.includes(' = ')) {
      const [field, value] = condition.split(' = ');
      const cleanValue = value.replace(/'/g, '');
      return item[field] == cleanValue;
    }
    if (condition.includes(' > ')) {
      const [field, value] = condition.split(' > ');
      return item[field] > Number(value);
    }
    if (condition.includes(' < ')) {
      const [field, value] = condition.split(' < ');
      return item[field] < Number(value);
    }
    if (condition.includes(' LIKE ')) {
      const [field, pattern] = condition.split(' LIKE ');
      const regex = new RegExp(pattern.replace(/'/g, '').replace(/%/g, '.*'));
      return regex.test(item[field]);
    }
    return true;
  }

  private applyJoins(results: any[]): any[] {
    if (this.joins.length === 0) return results;

    return results.map(result => {
      const joinedResult = { ...result };
      
      for (const join of this.joins) {
        const joinedData = this.data[join.table] || [];
        if (join.type === 'LEFT') {
          const matches = joinedData.filter(item => 
            this.evaluateCondition(join.condition, { ...item, ...result })
          );
          joinedResult[join.alias] = matches;
        } else if (join.type === 'INNER') {
          const matches = joinedData.filter(item => 
            this.evaluateCondition(join.condition, { ...item, ...result })
          );
          if (matches.length > 0) {
            joinedResult[join.alias] = matches;
          } else {
            return null;
          }
        }
      }
      
      return joinedResult;
    }).filter(result => result !== null);
  }

  private applyGroupBy(results: any[]): any[] {
    if (this.groupByFields.length === 0) return results;

    const groups = new Map();
    for (const result of results) {
      const key = this.groupByFields.map(field => result[field]).join('|');
      if (!groups.has(key)) {
        const groupResult: any = {};
        this.groupByFields.forEach(field => {
          groupResult[field] = result[field];
        });
        groupResult.count = 1;
        groups.set(key, groupResult);
      } else {
        groups.get(key).count++;
      }
    }

    return Array.from(groups.values());
  }

  async execute<T extends QueryResultRow = QueryResultRow>(): Promise<T[]> {
    let results = this.data[this.tableName] || [];

    // Apply conditions
    if (this.conditions.length > 0) {
      results = results.filter(item => 
        this.conditions.every(condition => this.evaluateCondition(condition, item))
      );
    }

    // Apply joins
    results = this.applyJoins(results);

    // Apply group by
    if (this.groupByFields.length > 0) {
      results = this.applyGroupBy(results);
    }

    // Apply order by
    if (this.orderByFields.length > 0) {
      results.sort((a, b) => {
        for (const orderBy of this.orderByFields) {
          const [field, direction] = orderBy.split(' ');
          if (a[field] < b[field]) return direction === 'ASC' ? -1 : 1;
          if (a[field] > b[field]) return direction === 'ASC' ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit and offset
    if (this.offsetValue !== undefined) {
      results = results.slice(this.offsetValue);
    }
    if (this.limitValue !== undefined) {
      results = results.slice(0, this.limitValue);
    }

    return results as T[];
  }

  async executeSingle<T extends QueryResultRow = QueryResultRow>(): Promise<T | null> {
    const results = await this.execute<T>();
    return results[0] || null;
  }

  async getRawMany<T extends QueryResultRow = QueryResultRow>(): Promise<T[]> {
    return this.execute<T>();
  }

  async getRawOne<T extends QueryResultRow = QueryResultRow>(): Promise<T | null> {
    return this.executeSingle<T>();
  }

  async getMany<T extends QueryResultRow = QueryResultRow>(): Promise<T[]> {
    return this.execute<T>();
  }

  async getOne<T extends QueryResultRow = QueryResultRow>(): Promise<T | null> {
    return this.executeSingle<T>();
  }

  getSql(): string {
    // For debugging purposes
    return `Mock SQL Query for ${this.tableName}`;
  }

  skip(count: number): this {
    return this.offset(count);
  }

  take(count: number): this {
    return this.limit(count);
  }
}

export class MockDatabaseService implements DatabaseService {
  private data: MockData = {
    users: [
      {
        id: '1',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'MEMBER',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01')
      },
      {
        id: '2',
        name: 'Jane Smith',
        email: 'jane@example.com',
        role: 'ADMIN',
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02')
      }
    ],
    tasks: [
      {
        id: '1',
        title: 'Task 1',
        description: 'Description 1',
        userId: '1',
        status: 'TODO',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01')
      },
      {
        id: '2',
        title: 'Task 2',
        description: 'Description 2',
        userId: '2',
        status: 'IN_PROGRESS',
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02')
      }
    ],
    projects: [
      {
        id: '1',
        name: 'Project 1',
        description: 'Description 1',
        ownerId: '1',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01')
      },
      {
        id: '2',
        name: 'Project 2',
        description: 'Description 2',
        ownerId: '2',
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02')
      }
    ]
  };

  async findOne<T extends QueryResultRow>(tableName: string, where: object): Promise<T | null> {
    const conditions = Object.entries(where).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    const result = await this.createQueryBuilder(tableName)
      .where(conditions[0])
      .executeSingle<T>();
    return result;
  }

  async find<T>(tableName: string, query: Partial<T>): Promise<T[]> {
    const table = this.data[tableName];
    if (!table) return [];
    
    return table.filter(item => {
      return Object.entries(query).every(([key, value]) => item[key] === value);
    }) as T[];
  }

  async insert<T>(tableName: string, data: Partial<T>): Promise<T> {
    if (!this.data[tableName]) {
      this.data[tableName] = [];
    }

    const newItem = {
      id: randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.data[tableName].push(newItem);
    return newItem as T;
  }

  async update<T extends QueryResultRow>(tableName: string, where: object, data: Partial<T>): Promise<T[]> {
    const conditions = Object.entries(where).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    const records = await this.createQueryBuilder(tableName)
      .where(conditions[0])
      .execute<T>();
    
    records.forEach(record => {
      Object.assign(record, data);
    });

    return records;
  }

  async delete(tableName: string, where: object): Promise<number> {
    const conditions = Object.entries(where).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    const records = await this.createQueryBuilder(tableName)
      .where(conditions[0])
      .execute();
    
    const count = records.length;
    this.data[tableName] = this.data[tableName].filter(record => 
      !records.includes(record)
    );

    return count;
  }

  createQueryBuilder(tableName: string, alias?: string): QueryBuilder {
    return new MockQueryBuilder(tableName, this.data, alias);
  }
} 
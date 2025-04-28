import { EntityTarget, ObjectLiteral, Repository, DeepPartial, FindOptionsWhere, UpdateResult, DeleteResult, EntityManager, SelectQueryBuilder, QueryRunner } from 'typeorm';
import { getDataSource } from '../data-source';
import { NeonDataSource } from './NeonDataSource';
import type { Context } from 'hono'; // Import Hono context
import type { Env } from '../../types/env'; // Import Env type
// Removed: import type { Env } from '../../types/env'; // Assuming Env is not needed just for NeonService

// Import the global DataSource getter
// let dataSource: DataSource | null = null;

// REMOVE DatabaseConfig interface
/*
export interface DatabaseConfig {
  url: string;
  synchronize?: boolean;
  logging?: boolean;
}
*/

// REMOVE getTypeORMDataSource function
/*
export async function getTypeORMDataSource(config?: DatabaseConfig): Promise<DataSource> { ... }
*/

// REMOVE getRepository function
/*
export async function getRepository<T extends ObjectLiteral>(entityClass: EntityTarget<T>): Promise<Repository<T>> { ... }
*/

// REMOVE create function
/*
export async function create<T extends ObjectLiteral>(entityClass: EntityTarget<T>, data: DeepPartial<T>): Promise<T> { ... }
*/

// REMOVE update function
/*
export async function update<T extends ObjectLiteral>(entityClass: EntityTarget<T>, id: any, data: DeepPartial<T>): Promise<boolean> { ... }
*/

// REMOVE remove function
/*
export async function remove<T extends ObjectLiteral>(entityClass: EntityTarget<T>, id: any): Promise<boolean> { ... }
*/

// REMOVE findOne function
/*
export async function findOne<T extends ObjectLiteral>(entityClass: EntityTarget<T>, where: DeepPartial<T>): Promise<T | null> { ... }
*/

// REMOVE find function
/*
export async function find<T extends ObjectLiteral>(entityClass: EntityTarget<T>, where?: DeepPartial<T>): Promise<T[]> { ... }
*/

// KEEP NeonService class
export class NeonService {
  private context: Context<{ Bindings: Env }> ;
  // Cache the data source instance per service instance to avoid repeated calls to getDataSource
  private dataSourceInstance: NeonDataSource | null = null; 

  constructor(c: Context<{ Bindings: Env }>) {
    this.context = c;
  }

  // Simplify getManager to retrieve the already initialized manager
  private async getManager(): Promise<EntityManager> {
    // Get the instance or initialize it if not already cached
    if (!this.dataSourceInstance) {
      this.dataSourceInstance = await getDataSource(this.context); 
    }
    
    // Ensure the dataSource and its manager are initialized
    if (!this.dataSourceInstance || !this.dataSourceInstance.isInitialized || !this.dataSourceInstance.manager) {
      // This should ideally not happen if getDataSource handles initialization correctly
      console.error("NeonService Error: DataSource or EntityManager not available after getDataSource call.");
      throw new Error("DataSource is not properly initialized.");
    }
    
    // Return the manager from the cached instance
    return this.dataSourceInstance.manager;
  }

  async createQueryBuilder<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    alias: string,
    queryRunner?: QueryRunner
  ): Promise<SelectQueryBuilder<Entity>> {
    const manager = await this.getManager();
    return manager.createQueryBuilder(entityTarget, alias, queryRunner);
  }

  async findOne<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    where: FindOptionsWhere<Entity>
  ): Promise<Entity | null> {
    const manager = await this.getManager();
    return manager.findOne(entityTarget, { where });
  }

  async find<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    where?: FindOptionsWhere<Entity>
  ): Promise<Entity[]> {
    const manager = await this.getManager();
    return manager.find(entityTarget, { where });
  }

  async count<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    where?: FindOptionsWhere<Entity>
  ): Promise<number> {
    const manager = await this.getManager();
    return manager.count(entityTarget, { where });
  }

  async insert<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    data: DeepPartial<Entity>
  ): Promise<Entity> {
    const manager = await this.getManager();
    const entity = manager.create(entityTarget, data);
    return await manager.save(entityTarget, entity) as Entity;
  }

  async update<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    criteria: FindOptionsWhere<Entity>,
    data: DeepPartial<Entity>
  ): Promise<UpdateResult> {
    const manager = await this.getManager();
    return manager.update(entityTarget, criteria, data as any);
  }

  async delete<Entity extends ObjectLiteral>(
    entityTarget: EntityTarget<Entity>,
    criteria: FindOptionsWhere<Entity>
  ): Promise<DeleteResult> {
    const manager = await this.getManager();
    return manager.delete(entityTarget, criteria);
  }
} 
// Re-export entity definitions from generated barrel files
// @ts-ignore - TypeScript doesn't know about these imports
import { serverEntities } from './generated/server-entities.js';
// @ts-ignore - TypeScript doesn't know about these imports
import { clientEntities } from './generated/client-entities.js';

// Re-export all entities from generated files
export * from './generated/server-entities.js';
export * from './generated/client-entities.js';

// Re-export table category constants for use in other packages
export { SERVER_DOMAIN_TABLES, SERVER_SYSTEM_TABLES } from './generated/server-entities.js';
export { CLIENT_DOMAIN_TABLES, CLIENT_SYSTEM_TABLES } from './generated/client-entities.js';

// Re-export context decorators
export * from './utils/context.js';

// Re-export validation utilities
export * from './utils/validation.js';

// Export entity arrays
export { serverEntities, clientEntities };

// Conditionally import and export datasources
// This prevents browser environments from importing Node.js-specific modules
// @ts-ignore - TypeScript doesn't know about this global
declare const process: { versions?: { node?: string } } | undefined;

// Create placeholder for datasources that will be populated in Node.js environment
let serverDataSource: any = undefined;
let clientDataSource: any = undefined;

// Only load datasources in Node.js environment
if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  // We're in Node.js - use dynamic import to load datasources
  // This code will be tree-shaken out in browser builds
  import('./datasources/server.js').then(module => {
    serverDataSource = module.default;
  }).catch(err => {
    console.error('Failed to load server datasource:', err);
  });
  
  import('./datasources/client.js').then(module => {
    clientDataSource = module.default;
  }).catch(err => {
    console.error('Failed to load client datasource:', err);
  });
}

// Export datasources (will be undefined in browser)
export { serverDataSource, clientDataSource };

// Re-export TypeORM essentials
export {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinTable,
  JoinColumn,
  RelationId,
  Relation
} from 'typeorm'; 
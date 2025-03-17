import { getMetadataArgsStorage } from 'typeorm';
import pkg from 'glob';
const { glob } = pkg;
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { isServerOnly, isClientOnly, isServerEntity, isClientEntity, METADATA_KEYS } from './context.js';

const globPromise = promisify(glob);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

export class MetadataFilter {
    private readonly metadataStorage = getMetadataArgsStorage();

    /**
     * Discover all entity files in the entities directory
     */
    async discoverEntities(): Promise<Function[]> {
        const entityFiles = await globPromise(path.join(PACKAGE_ROOT, 'src/entities/**/*.{ts,js}'), {
            ignore: ['**/*.test.ts', '**/*.spec.ts'],
            absolute: true
        });

        console.log('Found entity files:', entityFiles);
        const entities: Function[] = [];

        for (const file of entityFiles) {
            const module = await import(file);
            // Find class with @Entity decorator
            const entityClass = Object.values(module).find(exp => 
                this.metadataStorage.tables.some(t => t.target === exp)
            );
            
            if (entityClass) {
                console.log('Found entity:', (entityClass as any).name);
                entities.push(entityClass as Function);
            }
        }

        return entities;
    }

    /**
     * Filter entity metadata for a specific context
     */
    filterEntityMetadata(entity: Function, context: 'server' | 'client') {
        const isServer = context === 'server';
        const entityName = (entity as any).name;
        
        // Check if entity is context-specific at class level
        if (isServer && isClientEntity(entity)) {
            console.log(`Excluding ${entityName} from server context - marked as ClientOnly`);
            return { columns: [], relations: [] };
        }
        if (!isServer && isServerEntity(entity)) {
            console.log(`Excluding ${entityName} from client context - marked as ServerOnly`);
            return { columns: [], relations: [] };
        }
        
        // Get columns for this entity
        const columns = this.metadataStorage.columns
            .filter(column => column.target === entity)
            .filter(column => {
                if (isServer && isClientOnly(entity.prototype, column.propertyName)) {
                    console.log(`Excluding column ${entityName}.${column.propertyName} from server context - marked as ClientOnly`);
                    return false;
                }
                if (!isServer && isServerOnly(entity.prototype, column.propertyName)) {
                    console.log(`Excluding column ${entityName}.${column.propertyName} from client context - marked as ServerOnly`);
                    return false;
                }
                return true;
            });

        // Get relations for this entity
        const relations = this.metadataStorage.relations
            .filter(relation => relation.target === entity)
            .filter(relation => {
                if (isServer && isClientOnly(entity.prototype, relation.propertyName)) {
                    console.log(`Excluding relation ${entityName}.${relation.propertyName} from server context - marked as ClientOnly`);
                    return false;
                }
                if (!isServer && isServerOnly(entity.prototype, relation.propertyName)) {
                    console.log(`Excluding relation ${entityName}.${relation.propertyName} from client context - marked as ServerOnly`);
                    return false;
                }
                return true;
            });

        return { columns, relations };
    }
    
    /**
     * Get the table name for an entity class
     * Uses the @Entity decorator's name parameter
     */
    getTableName(entity: Function): string | undefined {
        const tableMetadata = this.metadataStorage.tables.find(t => t.target === entity);
        return tableMetadata?.name;
    }
} 
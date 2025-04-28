/**
 * Query Builder Factory
 * 
 * Static utility methods for creating query builders directly without circular references.
 * This is useful when we need to create query builders from within a QueryRunner
 * without calling back to DataSource.createQueryBuilder() which would create a circular reference.
 */

import { 
    DataSource, 
    EntityTarget,
    ObjectLiteral, 
    QueryRunner, 
    SelectQueryBuilder
} from "typeorm";

/**
 * Custom SelectQueryBuilder that safely wraps the executeEntitiesAndRawResults method
 * to prevent errors related to missing subscribers array.
 */
class NewSelectQueryBuilder<Entity extends ObjectLiteral> extends SelectQueryBuilder<Entity> {
    /**
     * Safely wraps the executeEntitiesAndRawResults method to prevent errors from broadcast events
     */
    protected async executeEntitiesAndRawResults(queryRunner: QueryRunner): Promise<{ entities: Entity[], raw: any[] }> {
        try {
            // Ensure queryRunner.connection.subscribers exists
            if (queryRunner?.connection && !queryRunner.connection.subscribers) {
                console.warn('Initializing missing subscribers array on connection');
                (queryRunner.connection as any).subscribers = [];
            }
            
            // Call the original method
            return await super.executeEntitiesAndRawResults(queryRunner);
        } catch (error) {
            // If there's an error about filter of undefined, we know it's related to broadcasting
            if (error instanceof TypeError && error.message.includes("filter") && error.message.includes("undefined")) {
                console.warn("Caught error in executeEntitiesAndRawResults about undefined filter - using fallback");
                
                // Perform a raw query directly without the broadcasting step
                const rawResults = await this.loadRawResults(queryRunner);
                
                // Return just the raw results without transformation or broadcasting
                return {
                    raw: rawResults,
                    entities: rawResults as Entity[]
                };
            }
            
            // For other errors, rethrow
            throw error;
        }
    }
}

export class QueryBuilderFactory {
    /**
     * Creates a SelectQueryBuilder instance directly without using DataSource.createQueryBuilder()
     * to avoid circular references.
     * Handles potentially undefined entityTarget for internal TypeORM calls.
     * 
     * @param connection The DataSource instance
     * @param entityTarget The entity target (can be undefined for internal calls)
     * @param alias The alias for the entity (should generally be provided)
     * @param queryRunner Optional QueryRunner to use
     * @returns A new SelectQueryBuilder instance
     */
    static createSelectQueryBuilder<Entity extends ObjectLiteral>(
        connection: DataSource,
        entityTarget: EntityTarget<Entity> | undefined,
        alias: string,
        queryRunner?: QueryRunner
    ): SelectQueryBuilder<Entity> {
        // Create a new custom SelectQueryBuilder directly
        const qb = new NewSelectQueryBuilder<Entity>(connection, queryRunner);
        
        // Only set from/select if entityTarget is provided
        if (entityTarget) {
            const metadata = connection.getMetadata(entityTarget);
            // Use the public select() and from() methods to build the query properly
            qb.select(alias).from(metadata.target, alias);
        } 
        // If entityTarget is undefined, return the base builder.
        // Internal TypeORM methods (.update(), .delete()) will chain off this.
        
        return qb;
    }
} 
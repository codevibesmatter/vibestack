import 'reflect-metadata';
import { MetadataFilter } from '../utils/metadata-filter.js';
import { getTableCategory, TableCategory } from '../utils/context.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

async function generateContextEntities() {
    const filter = new MetadataFilter();
    const entities = await filter.discoverEntities();
    
    // Ensure generated directory exists
    const generatedDir = path.join(PACKAGE_ROOT, 'src/generated');
    await fs.mkdir(generatedDir, { recursive: true });
    
    console.log('Discovered entities:', entities.map(e => e.name));
    
    // Generate server context
    const serverOutput = generateContextOutput(entities, 'server', filter);
    const serverPath = path.join(generatedDir, 'server-entities.ts');
    await fs.writeFile(serverPath, serverOutput);
    console.log('Generated server entities at:', serverPath);

    // Generate client context
    const clientOutput = generateContextOutput(entities, 'client', filter);
    const clientPath = path.join(generatedDir, 'client-entities.ts');
    await fs.writeFile(clientPath, clientOutput);
    console.log('Generated client entities at:', clientPath);
}

function generateContextOutput(
    entities: Function[],
    context: 'server' | 'client',
    filter: MetadataFilter
): string {
    let output = `// Generated ${context} entities - DO NOT EDIT\n\n`;
    
    // Add imports
    entities.forEach(entity => {
        const name = entity.name;
        output += `import { ${name} } from '../entities/${name}.js';\n`;
    });
    
    output += '\n';
    
    // Add filtered re-exports
    entities.forEach(entity => {
        const { columns, relations } = filter.filterEntityMetadata(entity, context);
        const name = entity.name;
        
        // Only export if entity has columns or relations for this context
        if (columns.length > 0 || relations.length > 0) {
            output += `export * from '../entities/${name}.js';\n`;
        }
    });
    
    // Add direct entity exports for better type access
    output += '\n// Direct entity exports for type access\n';
    entities.forEach(entity => {
        const { columns, relations } = filter.filterEntityMetadata(entity, context);
        const name = entity.name;
        
        // Only export if entity has columns or relations for this context
        if (columns.length > 0 || relations.length > 0) {
            output += `export { ${name} };\n`;
        }
    });
    
    output += '\n';
    
    // Export entity array
    output += `// Export entity array for TypeORM\n`;
    output += `export const ${context}Entities = [\n`;
    entities.forEach(entity => {
        const { columns, relations } = filter.filterEntityMetadata(entity, context);
        // Only include if entity has columns or relations for this context
        if (columns.length > 0 || relations.length > 0) {
            output += `  ${entity.name},\n`;
        }
    });
    output += `];\n\n`;
    
    // Generate categorized table lists
    const categorizedEntities = new Map<TableCategory, Function[]>();
    
    // Initialize categories
    categorizedEntities.set('domain', []);
    categorizedEntities.set('system', []);
    categorizedEntities.set('utility', []);
    
    // Group entities by category
    entities.forEach(entity => {
        const { columns, relations } = filter.filterEntityMetadata(entity, context);
        // Only include if entity has columns or relations for this context
        if (columns.length > 0 || relations.length > 0) {
            const category = getTableCategory(entity) || 'system'; // Default to system if not specified
            const categoryEntities = categorizedEntities.get(category) || [];
            categoryEntities.push(entity);
            categorizedEntities.set(category, categoryEntities);
        }
    });
    
    // Generate table name constants for each category
    for (const [category, categoryEntities] of categorizedEntities.entries()) {
        if (categoryEntities.length > 0) {
            const categoryUpper = category.toUpperCase();
            const contextUpper = context.toUpperCase();
            output += `// ${category} tables for ${context} context\n`;
            output += `export const ${contextUpper}_${categoryUpper}_TABLES = [\n`;
            
            // Get table names from entity metadata
            categoryEntities.forEach(entity => {
                const tableName = filter.getTableName(entity);
                if (tableName) {
                    output += `  '"${tableName}"',\n`;
                }
            });
            
            output += `] as const;\n\n`;
        }
    }
    
    return output;
}

// Run the generator
generateContextEntities().catch(error => {
    console.error('Error generating context entities:', error);
    process.exit(1);
}); 
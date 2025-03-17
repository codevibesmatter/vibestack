import * as ts from 'typescript';
import { QualityViolation } from './index';

interface TypeSafetyConfig {
  // No local types rule
  allowLocalTypes: boolean;
  allowedTypeLocations: string[];
  
  // No type assertions rule
  allowTypeAssertions: boolean;
  allowedAssertionPatterns: string[];
  
  // Serialization safety
  requireSerializationHelpers: boolean;
  serializationHelperPaths: string[];
  
  // Schema compatibility
  enforceSchemaVersioning: boolean;
  schemaLocations: string[];
  
  // Worker/DO safety
  enforceWorkerTypes: boolean;
  enforceDOTypes: boolean;
  workerBaseClass: string;
  doBaseClass: string;
}

export const defaultTypeSafetyConfig: TypeSafetyConfig = {
  allowLocalTypes: false,
  allowedTypeLocations: [
    'packages/shared-types/',
    'packages/config/code-quality/',  // Exempt code quality package itself
    '**/worker-configuration.d.ts'    // Allow Wrangler-generated type definitions
  ],
  allowTypeAssertions: false,
  allowedAssertionPatterns: [
    'packages/config/code-quality/'  // Exempt code quality package itself
  ],
  requireSerializationHelpers: true,
  serializationHelperPaths: [
    'packages/shared-types/src/serialization.ts'
  ],
  enforceSchemaVersioning: true,
  schemaLocations: ['packages/shared-types/src/schemas/'],
  enforceWorkerTypes: true,
  enforceDOTypes: true,
  workerBaseClass: 'TypedWorker',
  doBaseClass: 'TypedDurableObject'
};

interface TypeSafetyMessage {
  type: 'TYPE_SAFETY';
  message: string;
  details: string;
  location: { 
    file: string; 
    line: number;
    column: number;
    context?: string;
  };
  severity: 'error' | 'warning';
  suggestion?: string;
}

function isTypeSafetyMessage(value: unknown): value is TypeSafetyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    msg.type === 'TYPE_SAFETY' &&
    typeof msg.message === 'string' &&
    typeof msg.details === 'string' &&
    typeof msg.location === 'object' &&
    msg.location !== null &&
    'file' in msg.location &&
    'line' in msg.location &&
    'column' in msg.location &&
    typeof (msg.location as Record<string, unknown>).file === 'string' &&
    typeof (msg.location as Record<string, unknown>).line === 'number' &&
    typeof (msg.location as Record<string, unknown>).column === 'number' &&
    (msg.severity === 'error' || msg.severity === 'warning') &&
    (msg.suggestion === undefined || typeof msg.suggestion === 'string')
  );
}

function createQualityViolation(message: TypeSafetyMessage): QualityViolation {
  if (!isTypeSafetyMessage(message)) {
    throw new Error('Invalid TypeSafetyMessage');
  }
  return {
    type: message.type,
    message: `${message.message}\n\n${message.details}`,
    location: message.location,
    severity: message.severity,
    suggestion: message.suggestion
  };
}

const TYPE_SAFETY_MESSAGES = {
  localTypes: (file: string, line: number): QualityViolation => {
    const msg: TypeSafetyMessage = {
      type: 'TYPE_SAFETY',
      message: 'Local type definitions are not allowed',
      details: `Types should be defined in @repo/shared-types package. Found local types in ${file}.
    
Fix: 
1. Move types to appropriate directory in @repo/shared-types:
   - Domain types -> domain/schemas/
   - TinyBase types -> tinybase/
   - Infrastructure -> cloudflare/
   
2. Import types:
   import type { YourType } from '@repo/shared-types/domain/schemas';
   
See packages/shared-types/docs/README.md for more details.`,
      location: { file, line, column: 1 },
      severity: 'error',
      suggestion: 'Move type definition to @repo/shared-types package'
    };
    return createQualityViolation(msg);
  },

  typeAssertions: (file: string, line: number, column: number, nodeText: string, context: string): QualityViolation => {
    const msg: TypeSafetyMessage = {
      type: 'TYPE_SAFETY',
      message: 'Type assertions should be avoided',
      details: `Found type assertion at ${file}:${line}:${column}

Code context:
${context}

Fix:
1. Use runtime validation with Zod schemas from @repo/shared-types
2. Use type guards for narrowing
3. Fix type definitions if assertions are needed

Example:
import { userSchema } from '@repo/shared-types/domain/schemas';
const result = userSchema.safeParse(data);
if (result.success) {
  // data is properly typed
}`,
      location: { file, line, column, context },
      severity: 'error',
      suggestion: 'Use runtime validation or type guards instead'
    };
    return createQualityViolation(msg);
  },

  serialization: (file: string, line: number, nodeText: string): QualityViolation => {
    const msg: TypeSafetyMessage = {
      type: 'TYPE_SAFETY',
      message: 'Use type-safe serialization helpers',
      details: `Direct JSON serialization found: ${nodeText}
    
Fix:
Import serialization helpers from @repo/shared-types:
import { safeStringify, safeParse } from '@repo/shared-types/serialization/core';

Example:
const result = safeStringify(data);
if (result.success) {
  // serialization succeeded
}`,
      location: { file, line, column: 1 },
      severity: 'warning',
      suggestion: 'Use serialization helpers from @repo/shared-types'
    };
    return createQualityViolation(msg);
  },

  cloudflareTypes: (file: string, line: number, type: string): QualityViolation => {
    const msg: TypeSafetyMessage = {
      type: 'TYPE_SAFETY',
      message: 'Use typed Cloudflare definitions',
      details: `Missing type information for Cloudflare ${type}
    
Fix:
Import Cloudflare types from @repo/shared-types:
import type { Environment, DurableObjectState } from '@repo/shared-types/cloudflare';

See packages/shared-types/docs/README.md for Cloudflare types documentation.`,
      location: { file, line, column: 1 },
      severity: 'error',
      suggestion: `Use typed ${type} class from @repo/shared-types`
    };
    return createQualityViolation(msg);
  }
};

export class TypeSafetyChecker {
  constructor(
    private config: TypeSafetyConfig = defaultTypeSafetyConfig
  ) {}

  checkFile(sourceFile: ts.SourceFile): QualityViolation[] {
    const violations: QualityViolation[] = [];

    // Check for local type definitions
    if (!this.config.allowLocalTypes) {
      this.checkLocalTypes(sourceFile, violations);
    }

    // Check for type assertions
    if (!this.config.allowTypeAssertions) {
      this.checkTypeAssertions(sourceFile, violations);
    }

    // Check serialization safety
    if (this.config.requireSerializationHelpers) {
      this.checkSerializationUsage(sourceFile, violations);
    }

    // Check Worker/DO safety
    if (this.config.enforceWorkerTypes || this.config.enforceDOTypes) {
      this.checkCloudflareTypes(sourceFile, violations);
    }

    return violations;
  }

  private checkLocalTypes(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    const isAllowedLocation = this.config.allowedTypeLocations.some(
      location => sourceFile.fileName.includes(location)
    );

    if (!isAllowedLocation) {
      const visit = (node: ts.Node) => {
        if (
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node)
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(TYPE_SAFETY_MESSAGES.localTypes(sourceFile.fileName, line));
        }
        ts.forEachChild(node, visit);
      };
      
      visit(sourceFile);
    }
  }

  private checkTypeAssertions(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    const visit = (node: ts.Node) => {
      if (
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node)
      ) {
        const isAllowedPattern = this.config.allowedAssertionPatterns.some(
          pattern => sourceFile.fileName.includes(pattern)
        );

        if (!isAllowedPattern) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          
          // Get the context by finding the start and end of the line
          const sourceText = sourceFile.getFullText();
          const lineStart = sourceText.lastIndexOf('\n', node.getStart()) + 1;
          const lineEnd = sourceText.indexOf('\n', node.getStart());
          const context = sourceText.substring(
            lineStart,
            lineEnd === -1 ? sourceText.length : lineEnd
          ).trim();

          violations.push(TYPE_SAFETY_MESSAGES.typeAssertions(
            sourceFile.fileName, 
            line + 1, 
            character + 1,
            node.getText(),
            context
          ));
        }
      }
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);
  }

  private checkSerializationUsage(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let hasJsonMethods = false;
    let usesSerializationHelpers = false;
    let jsonNode: ts.Node | undefined;

    const visit = (node: ts.Node) => {
      // Check for direct JSON usage
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText() === 'JSON'
      ) {
        hasJsonMethods = true;
        jsonNode = node;
      }

      // Check for serialization helper imports
      if (ts.isImportDeclaration(node)) {
        const importPath = node.moduleSpecifier.getText();
        if (this.config.serializationHelperPaths.some(path => importPath.includes(path))) {
          usesSerializationHelpers = true;
        }
      }

      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);

    if (hasJsonMethods && !usesSerializationHelpers && jsonNode) {
      const line = sourceFile.getLineAndCharacterOfPosition(jsonNode.getStart()).line + 1;
      violations.push(TYPE_SAFETY_MESSAGES.serialization(sourceFile.fileName, line, jsonNode.getText()));
    }
  }

  private checkCloudflareTypes(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    // Check Workers
    if (
      this.config.enforceWorkerTypes &&
      sourceFile.fileName.includes('/workers/')
    ) {
      this.checkWorkerImplementation(sourceFile, violations);
    }

    // Check DOs
    if (
      this.config.enforceDOTypes &&
      sourceFile.fileName.includes('/do/')
    ) {
      this.checkDOImplementation(sourceFile, violations);
    }
  }

  private checkWorkerImplementation(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let extendsTypedWorker = false;
    let classNode: ts.Node | undefined;

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        classNode = node;
        if (node.heritageClauses?.some(
          clause => clause.getText().includes(this.config.workerBaseClass)
        )) {
          extendsTypedWorker = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);

    if (!extendsTypedWorker && classNode) {
      const line = sourceFile.getLineAndCharacterOfPosition(classNode.getStart()).line + 1;
      violations.push(TYPE_SAFETY_MESSAGES.cloudflareTypes(sourceFile.fileName, line, 'Worker'));
    }
  }

  private checkDOImplementation(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let extendsTypedDO = false;
    let classNode: ts.Node | undefined;

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        classNode = node;
        if (node.heritageClauses?.some(
          clause => clause.getText().includes(this.config.doBaseClass)
        )) {
          extendsTypedDO = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);

    if (!extendsTypedDO && classNode) {
      const line = sourceFile.getLineAndCharacterOfPosition(classNode.getStart()).line + 1;
      violations.push(TYPE_SAFETY_MESSAGES.cloudflareTypes(sourceFile.fileName, line, 'Durable Object'));
    }
  }
} 
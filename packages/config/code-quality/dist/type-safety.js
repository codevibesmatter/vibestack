"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeSafetyChecker = exports.defaultTypeSafetyConfig = void 0;
const ts = __importStar(require("typescript"));
exports.defaultTypeSafetyConfig = {
    allowLocalTypes: false,
    allowedTypeLocations: [
        'packages/shared-types/',
        'packages/config/code-quality/', // Exempt code quality package itself
        '**/worker-configuration.d.ts' // Allow Wrangler-generated type definitions
    ],
    allowTypeAssertions: false,
    allowedAssertionPatterns: [
        'packages/config/code-quality/' // Exempt code quality package itself
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
function isTypeSafetyMessage(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const msg = value;
    return (msg.type === 'TYPE_SAFETY' &&
        typeof msg.message === 'string' &&
        typeof msg.details === 'string' &&
        typeof msg.location === 'object' &&
        msg.location !== null &&
        'file' in msg.location &&
        'line' in msg.location &&
        'column' in msg.location &&
        typeof msg.location.file === 'string' &&
        typeof msg.location.line === 'number' &&
        typeof msg.location.column === 'number' &&
        (msg.severity === 'error' || msg.severity === 'warning') &&
        (msg.suggestion === undefined || typeof msg.suggestion === 'string'));
}
function createQualityViolation(message) {
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
    localTypes: (file, line) => {
        const msg = {
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
    typeAssertions: (file, line, column, nodeText, context) => {
        const msg = {
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
    serialization: (file, line, nodeText) => {
        const msg = {
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
    cloudflareTypes: (file, line, type) => {
        const msg = {
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
class TypeSafetyChecker {
    constructor(config = exports.defaultTypeSafetyConfig) {
        this.config = config;
    }
    checkFile(sourceFile) {
        const violations = [];
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
    checkLocalTypes(sourceFile, violations) {
        const isAllowedLocation = this.config.allowedTypeLocations.some(location => sourceFile.fileName.includes(location));
        if (!isAllowedLocation) {
            const visit = (node) => {
                if (ts.isInterfaceDeclaration(node) ||
                    ts.isTypeAliasDeclaration(node)) {
                    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    violations.push(TYPE_SAFETY_MESSAGES.localTypes(sourceFile.fileName, line));
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }
    }
    checkTypeAssertions(sourceFile, violations) {
        const visit = (node) => {
            if (ts.isAsExpression(node) ||
                ts.isTypeAssertionExpression(node)) {
                const isAllowedPattern = this.config.allowedAssertionPatterns.some(pattern => sourceFile.fileName.includes(pattern));
                if (!isAllowedPattern) {
                    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                    // Get the context by finding the start and end of the line
                    const sourceText = sourceFile.getFullText();
                    const lineStart = sourceText.lastIndexOf('\n', node.getStart()) + 1;
                    const lineEnd = sourceText.indexOf('\n', node.getStart());
                    const context = sourceText.substring(lineStart, lineEnd === -1 ? sourceText.length : lineEnd).trim();
                    violations.push(TYPE_SAFETY_MESSAGES.typeAssertions(sourceFile.fileName, line + 1, character + 1, node.getText(), context));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    checkSerializationUsage(sourceFile, violations) {
        let hasJsonMethods = false;
        let usesSerializationHelpers = false;
        let jsonNode;
        const visit = (node) => {
            // Check for direct JSON usage
            if (ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.expression.getText() === 'JSON') {
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
    checkCloudflareTypes(sourceFile, violations) {
        // Check Workers
        if (this.config.enforceWorkerTypes &&
            sourceFile.fileName.includes('/workers/')) {
            this.checkWorkerImplementation(sourceFile, violations);
        }
        // Check DOs
        if (this.config.enforceDOTypes &&
            sourceFile.fileName.includes('/do/')) {
            this.checkDOImplementation(sourceFile, violations);
        }
    }
    checkWorkerImplementation(sourceFile, violations) {
        let extendsTypedWorker = false;
        let classNode;
        const visit = (node) => {
            if (ts.isClassDeclaration(node)) {
                classNode = node;
                if (node.heritageClauses?.some(clause => clause.getText().includes(this.config.workerBaseClass))) {
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
    checkDOImplementation(sourceFile, violations) {
        let extendsTypedDO = false;
        let classNode;
        const visit = (node) => {
            if (ts.isClassDeclaration(node)) {
                classNode = node;
                if (node.heritageClauses?.some(clause => clause.getText().includes(this.config.doBaseClass))) {
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
exports.TypeSafetyChecker = TypeSafetyChecker;

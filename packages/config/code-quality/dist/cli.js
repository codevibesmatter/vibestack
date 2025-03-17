#!/usr/bin/env node
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
const glob_1 = require("glob");
const path_1 = require("path");
const index_1 = require("./index");
const type_safety_1 = require("./type-safety");
const ts = __importStar(require("typescript"));
// Get the project root directory (3 levels up from the dist directory)
const PROJECT_ROOT = (0, path_1.resolve)(__dirname, '../../../..');
// Package-specific configurations
const sharedTypesConfig = {
    ...index_1.defaultConfig,
    maxNestingDepth: {
        warning: 8, // More lenient warning threshold for shared-types
        error: 15 // More lenient error threshold for shared-types
    }
};
function getConfigForFile(filePath) {
    if (filePath.includes('packages/shared-types/')) {
        return sharedTypesConfig;
    }
    return index_1.defaultConfig;
}
async function findFiles() {
    return new Promise((resolve, reject) => {
        // Run glob from the project root
        (0, glob_1.glob)('**/*.{ts,tsx}', {
            ignore: [
                '**/node_modules/**',
                '**/dist/**',
                '**/.next/**',
                '**/*.test.ts',
                '**/*.spec.ts',
                // Ignore the code-quality package itself
                'packages/config/code-quality/**'
            ],
            cwd: PROJECT_ROOT
        }, (err, matches) => {
            if (err)
                reject(err);
            else
                resolve(matches);
        });
    });
}
function processViolation(violation, hasErrors, hasWarnings) {
    if (violation.severity === 'error') {
        console.error(`❌ ${violation.location.file}: ${violation.message}`);
        if (violation.suggestion) {
            console.error(`   💡 ${violation.suggestion}`);
        }
        return [true, hasWarnings];
    }
    else {
        console.warn(`⚠️  ${violation.location.file}: ${violation.message}`);
        if (violation.suggestion) {
            console.warn(`   💡 ${violation.suggestion}`);
        }
        return [hasErrors, true];
    }
}
async function processFile(codeChecker, typeChecker, file, hasErrors, hasWarnings) {
    // Resolve file path relative to project root
    const fullPath = (0, path_1.join)(PROJECT_ROOT, file);
    // Get the appropriate config for this file
    const config = getConfigForFile(fullPath);
    const fileChecker = new index_1.CodeQualityChecker(config);
    // Run code quality checks with the appropriate config
    const codeViolations = await fileChecker.checkFile(fullPath);
    let currentErrors = hasErrors;
    let currentWarnings = hasWarnings;
    for (const violation of codeViolations) {
        [currentErrors, currentWarnings] = processViolation(violation, currentErrors, currentWarnings);
    }
    // Run type safety checks
    const sourceFile = ts.createSourceFile(fullPath, await readFile(fullPath), ts.ScriptTarget.Latest, true);
    const typeViolations = typeChecker.checkFile(sourceFile);
    for (const violation of typeViolations) {
        [currentErrors, currentWarnings] = processViolation(violation, currentErrors, currentWarnings);
    }
    return [currentErrors, currentWarnings];
}
async function readFile(path) {
    return new Promise((resolve, reject) => {
        require('fs').readFile(path, 'utf8', (err, data) => {
            if (err)
                reject(err);
            else
                resolve(data);
        });
    });
}
async function main() {
    console.log('Running code quality and type safety checks from:', PROJECT_ROOT);
    const codeChecker = new index_1.CodeQualityChecker();
    const typeChecker = new type_safety_1.TypeSafetyChecker();
    const files = await findFiles();
    if (files.length === 0) {
        console.warn('No TypeScript files found to check!');
        return;
    }
    console.log(`Found ${files.length} files to check...`);
    let hasErrors = false;
    let hasWarnings = false;
    for (const file of files) {
        [hasErrors, hasWarnings] = await processFile(codeChecker, typeChecker, file, hasErrors, hasWarnings);
    }
    if (hasErrors) {
        console.error('\n❌ Quality checks failed with errors');
        process.exit(1);
    }
    else if (hasWarnings) {
        console.warn('\n⚠️  Quality checks passed with warnings');
    }
    else {
        console.log('\n✅ All quality checks passed!');
    }
}
main().catch(error => {
    console.error('Failed to run quality checks:', error);
    process.exit(1);
});

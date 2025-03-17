#!/usr/bin/env node
import { glob } from 'glob';
import { resolve, join } from 'path';
import { CodeQualityChecker, defaultConfig, CodeQualityConfig } from './index';
import { TypeSafetyChecker, defaultTypeSafetyConfig } from './type-safety';
import * as ts from 'typescript';

// Get the project root directory (3 levels up from the dist directory)
const PROJECT_ROOT = resolve(__dirname, '../../../..');

// Package-specific configurations
const sharedTypesConfig: CodeQualityConfig = {
  ...defaultConfig,
  maxNestingDepth: {
    warning: 8,    // More lenient warning threshold for shared-types
    error: 15      // More lenient error threshold for shared-types
  }
};

function getConfigForFile(filePath: string): CodeQualityConfig {
  if (filePath.includes('packages/shared-types/')) {
    return sharedTypesConfig;
  }
  return defaultConfig;
}

async function findFiles(): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // Run glob from the project root
    glob('**/*.{ts,tsx}', {
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
      if (err) reject(err);
      else resolve(matches);
    });
  });
}

function processViolation(violation: any, hasErrors: boolean, hasWarnings: boolean): [boolean, boolean] {
  if (violation.severity === 'error') {
    console.error(`❌ ${violation.location.file}: ${violation.message}`);
    if (violation.suggestion) {
      console.error(`   💡 ${violation.suggestion}`);
    }
    return [true, hasWarnings];
  } else {
    console.warn(`⚠️  ${violation.location.file}: ${violation.message}`);
    if (violation.suggestion) {
      console.warn(`   💡 ${violation.suggestion}`);
    }
    return [hasErrors, true];
  }
}

async function processFile(
  codeChecker: CodeQualityChecker,
  typeChecker: TypeSafetyChecker,
  file: string,
  hasErrors: boolean,
  hasWarnings: boolean
): Promise<[boolean, boolean]> {
  // Resolve file path relative to project root
  const fullPath = join(PROJECT_ROOT, file);
  
  // Get the appropriate config for this file
  const config = getConfigForFile(fullPath);
  const fileChecker = new CodeQualityChecker(config);
  
  // Run code quality checks with the appropriate config
  const codeViolations = await fileChecker.checkFile(fullPath);
  let currentErrors = hasErrors;
  let currentWarnings = hasWarnings;

  for (const violation of codeViolations) {
    [currentErrors, currentWarnings] = processViolation(violation, currentErrors, currentWarnings);
  }

  // Run type safety checks
  const sourceFile = ts.createSourceFile(
    fullPath,
    await readFile(fullPath),
    ts.ScriptTarget.Latest,
    true
  );
  
  const typeViolations = typeChecker.checkFile(sourceFile);
  for (const violation of typeViolations) {
    [currentErrors, currentWarnings] = processViolation(violation, currentErrors, currentWarnings);
  }

  return [currentErrors, currentWarnings];
}

async function readFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    require('fs').readFile(path, 'utf8', (err: any, data: string) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function main() {
  console.log('Running code quality and type safety checks from:', PROJECT_ROOT);
  const codeChecker = new CodeQualityChecker();
  const typeChecker = new TypeSafetyChecker();
  const files = await findFiles();

  if (files.length === 0) {
    console.warn('No TypeScript files found to check!');
    return;
  }

  console.log(`Found ${files.length} files to check...`);
  let hasErrors = false;
  let hasWarnings = false;

  for (const file of files) {
    [hasErrors, hasWarnings] = await processFile(
      codeChecker,
      typeChecker,
      file,
      hasErrors,
      hasWarnings
    );
  }

  if (hasErrors) {
    console.error('\n❌ Quality checks failed with errors');
    process.exit(1);
  } else if (hasWarnings) {
    console.warn('\n⚠️  Quality checks passed with warnings');
  } else {
    console.log('\n✅ All quality checks passed!');
  }
}

main().catch(error => {
  console.error('Failed to run quality checks:', error);
  process.exit(1);
}); 
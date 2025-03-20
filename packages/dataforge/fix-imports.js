#!/usr/bin/env node
/**
 * Script to fix imports in TypeScript files for ESM compatibility
 * Adds .js extensions to relative imports as required by ESM
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, 'src');

// Regex to match TypeScript imports and exports without extensions
const importRegex = /(from\s+['"])([^'"@][^'"]*?)(['"])/g;
const exportRegex = /(export\s+.*?\s+from\s+['"])([^'"@][^'"]*?)(['"])/g;

/**
 * Check if path is relative (not node_modules or absolute)
 */
function isRelativePath(importPath) {
  return importPath.startsWith('./') || importPath.startsWith('../');
}

/**
 * Add .js extension to import paths if they don't already have an extension
 */
function addJsExtension(match, prefix, importPath, suffix) {
  // Don't modify if it's not a relative path
  if (!isRelativePath(importPath)) {
    return match;
  }
  
  // Don't modify if it already has an extension
  if (path.extname(importPath) !== '') {
    return match;
  }
  
  // Add .js extension
  return `${prefix}${importPath}.js${suffix}`;
}

/**
 * Process a file to add .js extensions to imports
 */
function processFile(filePath) {
  try {
    // Read file content
    let content = fs.readFileSync(filePath, 'utf-8');
    
    // Skip if it's not a TypeScript file
    if (!filePath.endsWith('.ts')) {
      return;
    }
    
    // Apply transformations
    const newContent = content
      .replace(importRegex, addJsExtension)
      .replace(exportRegex, addJsExtension);
    
    // Write back if changed
    if (newContent !== content) {
      console.log(`Fixed imports in: ${filePath}`);
      fs.writeFileSync(filePath, newContent, 'utf-8');
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

/**
 * Recursively process all files in a directory
 */
function processDirectory(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    
    if (entry.isDirectory()) {
      // Skip node_modules
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      processDirectory(fullPath);
    } else {
      processFile(fullPath);
    }
  }
}

// Start processing from src directory
console.log('Fixing import paths for ESM compatibility...');
processDirectory(srcDir);
console.log('Done!'); 
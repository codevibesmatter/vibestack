const fs = require('fs');
const path = require('path');

function fixImports(dir) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      fixImports(filePath);
      return;
    }
    
    if (!['.js', '.mjs', '.d.ts'].some(ext => file.endsWith(ext))) {
      return;
    }
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Fix relative imports
    content = content.replace(
      /from ['"]\.\.?\/(.*?)['"]/g,
      (match, importPath) => {
        // Don't modify external package imports
        if (importPath.startsWith('@') || !importPath.includes('/')) {
          return match;
        }
        return `from './${importPath}'`;
      }
    );
    
    fs.writeFileSync(filePath, content);
  });
}

// Start fixing imports in the dist directory
fixImports(path.join(__dirname, '../dist')); 
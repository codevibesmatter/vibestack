import * as ts from 'typescript';
import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';

interface ComplexityMetrics {
  cyclomaticComplexity: number;
  nestingDepth: number;
  callbackChainDepth: number;
  switchCaseCount: number;
  asyncComplexity: number;
}

interface FunctionMetrics {
  lineCount: number;
  parameterCount: number;
  returnPointCount: number;
  closureDepth: number;
}

interface StateMetrics {
  stateAccessPoints: number;
  stateDependencyChain: number;
  asyncStateModifications: number;
}

// Enhanced config with new metrics
export interface CodeQualityConfig {
  maxFileSize: number;
  maxFunctions: number;
  maxComplexity: number;
  maxDependencies: number;
  maxStateProperties: number;
  enforceNaming: boolean;
  // New complexity limits
  maxNestingDepth: {
    warning: number;
    error: number;
  };
  maxCallbackChain: number;
  maxSwitchCases: number;
  maxAsyncComplexity: number;
  maxLineCount: number;
  maxParameters: number;
  maxReturnPoints: number;
  maxClosureDepth: number;
  maxStateAccess: number;
  maxStateDependencies: number;
  maxAsyncStateModifications: number;
}

export interface QualityViolation {
  type: 'SIZE' | 'COMPLEXITY' | 'DEPENDENCIES' | 'STATE' | 'NAMING' | 'NESTING' | 'ASYNC' | 'TYPE_SAFETY';
  message: string;
  location: {
    file: string;
    line?: number;
    column?: number;
  };
  severity: 'error' | 'warning';
  suggestion?: string;
}

// Updated defaults with new limits
export const defaultConfig: CodeQualityConfig = {
  maxFileSize: 100 * 1024,
  maxFunctions: 15,
  maxComplexity: 12,
  maxDependencies: 12,
  maxStateProperties: 8,
  enforceNaming: true,
  // Updated nesting depth thresholds based on TypeScript best practices
  maxNestingDepth: {
    warning: 4,  // Warn when nesting exceeds 4 levels
    error: 8     // Error when nesting exceeds 8 levels
  },
  // New limits
  maxCallbackChain: 3,
  maxSwitchCases: 5,
  maxAsyncComplexity: 4,
  maxLineCount: 50,
  maxParameters: 4,
  maxReturnPoints: 3,
  maxClosureDepth: 2,
  maxStateAccess: 5,
  maxStateDependencies: 3,
  maxAsyncStateModifications: 2
};

export class CodeQualityChecker {
  private cache: Map<string, string> = new Map();

  constructor(
    private config: CodeQualityConfig = defaultConfig
  ) {}

  async checkFile(filePath: string): Promise<QualityViolation[]> {
    const violations: QualityViolation[] = [];
    const content = readFileSync(filePath, 'utf-8');
    const hash = this.getFileHash(content);

    if (this.cache.get(filePath) === hash) {
      return [];
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // Basic checks
    this.checkFileSize(filePath, violations);
    this.countFunctions(sourceFile, violations);
    this.countDependencies(sourceFile, violations);
    
    // New complexity checks
    this.checkComplexityMetrics(sourceFile, violations);
    
    // DO/WAL specific checks
    if (filePath.includes('/do/')) {
      this.checkDOPatterns(sourceFile, violations);
    }
    if (filePath.includes('/wal/')) {
      this.checkWALPatterns(sourceFile, violations);
    }

    this.cache.set(filePath, hash);
    return violations;
  }

  private checkFileSize(filePath: string, violations: QualityViolation[]) {
    const stats = statSync(filePath);
    if (stats.size > this.config.maxFileSize) {
      violations.push({
        type: 'SIZE',
        message: `File exceeds size limit of ${this.config.maxFileSize} bytes`,
        location: { file: filePath },
        severity: 'error'
      });
    }
  }

  private checkComplexityMetrics(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) {
        const metrics = this.calculateComplexityMetrics(node);
        
        // Updated nesting depth check with more specific suggestions
        if (metrics.nestingDepth > this.config.maxNestingDepth.error) {
          violations.push({
            type: 'NESTING',
            message: `Nesting depth (${metrics.nestingDepth}) exceeds error limit (${this.config.maxNestingDepth.error})`,
            location: {
              file: sourceFile.fileName,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            },
            severity: 'error',
            suggestion: 'Consider:\n' +
              '1. Using early returns to reduce nesting\n' +
              '2. Extracting complex conditions into separate functions\n' +
              '3. Using async/await instead of nested callbacks\n' +
              '4. Breaking down the function into smaller, focused functions'
          });
        } else if (metrics.nestingDepth > this.config.maxNestingDepth.warning) {
          violations.push({
            type: 'NESTING',
            message: `Nesting depth (${metrics.nestingDepth}) exceeds warning limit (${this.config.maxNestingDepth.warning})`,
            location: {
              file: sourceFile.fileName,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            },
            severity: 'warning',
            suggestion: 'Consider:\n' +
              '1. Using guard clauses for early returns\n' +
              '2. Extracting nested logic into helper functions\n' +
              '3. Simplifying complex conditional logic'
          });
        }

        if (metrics.asyncComplexity > this.config.maxAsyncComplexity) {
          violations.push({
            type: 'ASYNC',
            message: `Async complexity (${metrics.asyncComplexity}) exceeds limit (${this.config.maxAsyncComplexity})`,
            location: {
              file: sourceFile.fileName,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            },
            severity: 'warning',
            suggestion: 'Consider breaking down async operations into smaller functions'
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private calculateComplexityMetrics(node: ts.Node): ComplexityMetrics {
    let metrics: ComplexityMetrics = {
      cyclomaticComplexity: 1,
      nestingDepth: 0,
      callbackChainDepth: 0,
      switchCaseCount: 0,
      asyncComplexity: 0
    };

    const visit = (node: ts.Node, depth: number = 0) => {
      metrics.nestingDepth = Math.max(metrics.nestingDepth, depth);

      if (ts.isIfStatement(node) || 
          ts.isConditionalExpression(node) ||
          ts.isForStatement(node) ||
          ts.isWhileStatement(node) ||
          ts.isDoStatement(node)) {
        metrics.cyclomaticComplexity++;
      }

      if (ts.isAwaitExpression(node)) {
        metrics.asyncComplexity++;
      }

      if (ts.isCallExpression(node) && 
          ts.isPropertyAccessExpression(node.expression)) {
        metrics.callbackChainDepth++;
      }

      if (ts.isSwitchStatement(node)) {
        metrics.switchCaseCount += node.caseBlock.clauses.length;
      }

      ts.forEachChild(node, n => visit(n, depth + 1));
    };

    visit(node);
    return metrics;
  }

  private countFunctions(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let count = 0;
    
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || 
          ts.isMethodDeclaration(node) || 
          ts.isArrowFunction(node)) {
        count++;
      }
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);

    if (count > this.config.maxFunctions) {
      violations.push({
        type: 'COMPLEXITY',
        message: `Too many functions (${count}/${this.config.maxFunctions})`,
        location: { file: sourceFile.fileName },
        severity: 'warning',
        suggestion: 'Consider splitting into multiple files'
      });
    }
  }

  private countDependencies(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let count = 0;
    
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        count++;
      }
      ts.forEachChild(node, visit);
    };
    
    visit(sourceFile);

    if (count > this.config.maxDependencies) {
      violations.push({
        type: 'DEPENDENCIES',
        message: `Too many dependencies (${count}/${this.config.maxDependencies})`,
        location: { file: sourceFile.fileName },
        severity: 'warning',
        suggestion: 'Consider grouping related imports or splitting functionality'
      });
    }
  }

  private checkDOPatterns(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let stateAccess = 0;
    let asyncModifications = 0;

    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && 
          node.expression.getText() === 'this.state') {
        stateAccess++;
      }

      if (ts.isAwaitExpression(node) && 
          node.expression.getText().includes('this.state')) {
        asyncModifications++;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (stateAccess > this.config.maxStateAccess) {
      violations.push({
        type: 'STATE',
        message: `Too many state access points (${stateAccess}/${this.config.maxStateAccess})`,
        location: { file: sourceFile.fileName },
        severity: 'warning',
        suggestion: 'Consider consolidating state access through getter/setter methods'
      });
    }

    if (asyncModifications > this.config.maxAsyncStateModifications) {
      violations.push({
        type: 'STATE',
        message: `Too many async state modifications (${asyncModifications}/${this.config.maxAsyncStateModifications})`,
        location: { file: sourceFile.fileName },
        severity: 'warning',
        suggestion: 'Consider batching state modifications or using transactions'
      });
    }
  }

  private checkWALPatterns(sourceFile: ts.SourceFile, violations: QualityViolation[]) {
    let lsnComparisons = 0;
    let eventHandlers = 0;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && 
          node.expression.getText().includes('compareLsn')) {
        lsnComparisons++;
      }

      if (ts.isMethodDeclaration(node) && 
          node.name.getText().includes('handle')) {
        eventHandlers++;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (lsnComparisons > 5) {
      violations.push({
        type: 'COMPLEXITY',
        message: 'Too many LSN comparisons in one file',
        location: { file: sourceFile.fileName },
        severity: 'warning',
        suggestion: 'Consider consolidating LSN logic into a dedicated manager'
      });
    }

    if (eventHandlers > 8) {
      violations.push({
        type: 'COMPLEXITY',
        message: 'Too many event handlers in one file',
        location: { file: sourceFile.fileName },
        severity: 'warning',
        suggestion: 'Consider splitting event handlers into separate modules'
      });
    }
  }

  private getFileHash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }
} 
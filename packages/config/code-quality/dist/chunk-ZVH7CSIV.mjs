// index.ts
import * as ts from "typescript";
import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
var defaultConfig = {
  maxFileSize: 100 * 1024,
  maxFunctions: 15,
  maxComplexity: 12,
  maxDependencies: 12,
  maxStateProperties: 8,
  enforceNaming: true,
  // New limits
  maxNestingDepth: 3,
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
var CodeQualityChecker = class {
  constructor(config = defaultConfig) {
    this.config = config;
    this.cache = /* @__PURE__ */ new Map();
  }
  async checkFile(filePath) {
    const violations = [];
    const content = readFileSync(filePath, "utf-8");
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
    this.checkFileSize(filePath, violations);
    this.countFunctions(sourceFile, violations);
    this.countDependencies(sourceFile, violations);
    this.checkComplexityMetrics(sourceFile, violations);
    if (filePath.includes("/do/")) {
      this.checkDOPatterns(sourceFile, violations);
    }
    if (filePath.includes("/wal/")) {
      this.checkWALPatterns(sourceFile, violations);
    }
    this.cache.set(filePath, hash);
    return violations;
  }
  checkFileSize(filePath, violations) {
    const stats = statSync(filePath);
    if (stats.size > this.config.maxFileSize) {
      violations.push({
        type: "SIZE",
        message: `File exceeds size limit of ${this.config.maxFileSize} bytes`,
        location: { file: filePath },
        severity: "error"
      });
    }
  }
  checkComplexityMetrics(sourceFile, violations) {
    const visit = (node) => {
      if (ts.isFunctionLike(node)) {
        const metrics = this.calculateComplexityMetrics(node);
        if (metrics.nestingDepth > this.config.maxNestingDepth) {
          violations.push({
            type: "NESTING",
            message: `Nesting depth (${metrics.nestingDepth}) exceeds limit (${this.config.maxNestingDepth})`,
            location: {
              file: sourceFile.fileName,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            },
            severity: "error",
            suggestion: "Consider extracting nested logic into separate functions"
          });
        }
        if (metrics.asyncComplexity > this.config.maxAsyncComplexity) {
          violations.push({
            type: "ASYNC",
            message: `Async complexity (${metrics.asyncComplexity}) exceeds limit (${this.config.maxAsyncComplexity})`,
            location: {
              file: sourceFile.fileName,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
            },
            severity: "warning",
            suggestion: "Consider breaking down async operations into smaller functions"
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  calculateComplexityMetrics(node) {
    let metrics = {
      cyclomaticComplexity: 1,
      nestingDepth: 0,
      callbackChainDepth: 0,
      switchCaseCount: 0,
      asyncComplexity: 0
    };
    const visit = (node2, depth = 0) => {
      metrics.nestingDepth = Math.max(metrics.nestingDepth, depth);
      if (ts.isIfStatement(node2) || ts.isConditionalExpression(node2) || ts.isForStatement(node2) || ts.isWhileStatement(node2) || ts.isDoStatement(node2)) {
        metrics.cyclomaticComplexity++;
      }
      if (ts.isAwaitExpression(node2)) {
        metrics.asyncComplexity++;
      }
      if (ts.isCallExpression(node2) && ts.isPropertyAccessExpression(node2.expression)) {
        metrics.callbackChainDepth++;
      }
      if (ts.isSwitchStatement(node2)) {
        metrics.switchCaseCount += node2.caseBlock.clauses.length;
      }
      ts.forEachChild(node2, (n) => visit(n, depth + 1));
    };
    visit(node);
    return metrics;
  }
  countFunctions(sourceFile, violations) {
    let count = 0;
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
        count++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (count > this.config.maxFunctions) {
      violations.push({
        type: "COMPLEXITY",
        message: `Too many functions (${count}/${this.config.maxFunctions})`,
        location: { file: sourceFile.fileName },
        severity: "warning",
        suggestion: "Consider splitting into multiple files"
      });
    }
  }
  countDependencies(sourceFile, violations) {
    let count = 0;
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        count++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (count > this.config.maxDependencies) {
      violations.push({
        type: "DEPENDENCIES",
        message: `Too many dependencies (${count}/${this.config.maxDependencies})`,
        location: { file: sourceFile.fileName },
        severity: "warning",
        suggestion: "Consider grouping related imports or splitting functionality"
      });
    }
  }
  checkDOPatterns(sourceFile, violations) {
    let stateAccess = 0;
    let asyncModifications = 0;
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "this.state") {
        stateAccess++;
      }
      if (ts.isAwaitExpression(node) && node.expression.getText().includes("this.state")) {
        asyncModifications++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (stateAccess > this.config.maxStateAccess) {
      violations.push({
        type: "STATE",
        message: `Too many state access points (${stateAccess}/${this.config.maxStateAccess})`,
        location: { file: sourceFile.fileName },
        severity: "warning",
        suggestion: "Consider consolidating state access through getter/setter methods"
      });
    }
    if (asyncModifications > this.config.maxAsyncStateModifications) {
      violations.push({
        type: "STATE",
        message: `Too many async state modifications (${asyncModifications}/${this.config.maxAsyncStateModifications})`,
        location: { file: sourceFile.fileName },
        severity: "warning",
        suggestion: "Consider batching state modifications or using transactions"
      });
    }
  }
  checkWALPatterns(sourceFile, violations) {
    let lsnComparisons = 0;
    let eventHandlers = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText().includes("compareLsn")) {
        lsnComparisons++;
      }
      if (ts.isMethodDeclaration(node) && node.name.getText().includes("handle")) {
        eventHandlers++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (lsnComparisons > 5) {
      violations.push({
        type: "COMPLEXITY",
        message: "Too many LSN comparisons in one file",
        location: { file: sourceFile.fileName },
        severity: "warning",
        suggestion: "Consider consolidating LSN logic into a dedicated manager"
      });
    }
    if (eventHandlers > 8) {
      violations.push({
        type: "COMPLEXITY",
        message: "Too many event handlers in one file",
        location: { file: sourceFile.fileName },
        severity: "warning",
        suggestion: "Consider splitting event handlers into separate modules"
      });
    }
  }
  getFileHash(content) {
    return createHash("md5").update(content).digest("hex");
  }
};

export {
  defaultConfig,
  CodeQualityChecker
};

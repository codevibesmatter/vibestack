interface CodeQualityConfig {
    maxFileSize: number;
    maxFunctions: number;
    maxComplexity: number;
    maxDependencies: number;
    maxStateProperties: number;
    enforceNaming: boolean;
    maxNestingDepth: number;
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
interface QualityViolation {
    type: 'SIZE' | 'COMPLEXITY' | 'DEPENDENCIES' | 'STATE' | 'NAMING' | 'NESTING' | 'ASYNC';
    message: string;
    location: {
        file: string;
        line?: number;
        column?: number;
    };
    severity: 'error' | 'warning';
    suggestion?: string;
}
declare const defaultConfig: CodeQualityConfig;
declare class CodeQualityChecker {
    private config;
    private cache;
    constructor(config?: CodeQualityConfig);
    checkFile(filePath: string): Promise<QualityViolation[]>;
    private checkFileSize;
    private checkComplexityMetrics;
    private calculateComplexityMetrics;
    private countFunctions;
    private countDependencies;
    private checkDOPatterns;
    private checkWALPatterns;
    private getFileHash;
}

export { CodeQualityChecker, defaultConfig };

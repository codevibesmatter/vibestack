import * as ts from 'typescript';
import { QualityViolation } from './index';
interface TypeSafetyConfig {
    allowLocalTypes: boolean;
    allowedTypeLocations: string[];
    allowTypeAssertions: boolean;
    allowedAssertionPatterns: string[];
    requireSerializationHelpers: boolean;
    serializationHelperPaths: string[];
    enforceSchemaVersioning: boolean;
    schemaLocations: string[];
    enforceWorkerTypes: boolean;
    enforceDOTypes: boolean;
    workerBaseClass: string;
    doBaseClass: string;
}
export declare const defaultTypeSafetyConfig: TypeSafetyConfig;
export declare class TypeSafetyChecker {
    private config;
    constructor(config?: TypeSafetyConfig);
    checkFile(sourceFile: ts.SourceFile): QualityViolation[];
    private checkLocalTypes;
    private checkTypeAssertions;
    private checkSerializationUsage;
    private checkCloudflareTypes;
    private checkWorkerImplementation;
    private checkDOImplementation;
}
export {};

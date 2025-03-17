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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorContext = exports.TypeErrorCategory = exports.taskCommentValidation = exports.taskTimeEntryValidation = exports.projectSettingsValidation = exports.userAuthValidation = exports.taskValidation = exports.projectValidation = exports.userValidation = exports.baseValidation = void 0;
// Base types
__exportStar(require("./domain/schemas/base"), exports);
__exportStar(require("./domain/enums"), exports);
// Service types
__exportStar(require("./domain/services"), exports);
// Validation
__exportStar(require("./validation/type-guards"), exports);
__exportStar(require("./validation/validators"), exports);
__exportStar(require("./validation/schemas"), exports);
// Environment types
__exportStar(require("./env/env-types"), exports);
// Domain types
__exportStar(require("./domain/user"), exports);
__exportStar(require("./domain/project"), exports);
__exportStar(require("./domain/task"), exports);
// Re-export validation schemas and types
var schemas_1 = require("./validation/schemas");
Object.defineProperty(exports, "baseValidation", { enumerable: true, get: function () { return schemas_1.baseValidation; } });
Object.defineProperty(exports, "userValidation", { enumerable: true, get: function () { return schemas_1.userValidation; } });
Object.defineProperty(exports, "projectValidation", { enumerable: true, get: function () { return schemas_1.projectValidation; } });
Object.defineProperty(exports, "taskValidation", { enumerable: true, get: function () { return schemas_1.taskValidation; } });
Object.defineProperty(exports, "userAuthValidation", { enumerable: true, get: function () { return schemas_1.userAuthValidation; } });
Object.defineProperty(exports, "projectSettingsValidation", { enumerable: true, get: function () { return schemas_1.projectSettingsValidation; } });
Object.defineProperty(exports, "taskTimeEntryValidation", { enumerable: true, get: function () { return schemas_1.taskTimeEntryValidation; } });
Object.defineProperty(exports, "taskCommentValidation", { enumerable: true, get: function () { return schemas_1.taskCommentValidation; } });
// Re-export error types
var types_1 = require("./error/types");
Object.defineProperty(exports, "TypeErrorCategory", { enumerable: true, get: function () { return types_1.TypeErrorCategory; } });
Object.defineProperty(exports, "ErrorContext", { enumerable: true, get: function () { return types_1.ErrorContext; } });

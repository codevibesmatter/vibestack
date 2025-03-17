// src/validation/services.ts
var ServiceErrorType = /* @__PURE__ */ ((ServiceErrorType2) => {
  ServiceErrorType2["VALIDATION"] = "VALIDATION";
  ServiceErrorType2["NOT_FOUND"] = "NOT_FOUND";
  ServiceErrorType2["INTERNAL"] = "INTERNAL";
  ServiceErrorType2["UNAUTHORIZED"] = "UNAUTHORIZED";
  ServiceErrorType2["FORBIDDEN"] = "FORBIDDEN";
  ServiceErrorType2["CONFLICT"] = "CONFLICT";
  ServiceErrorType2["UNKNOWN"] = "UNKNOWN";
  return ServiceErrorType2;
})(ServiceErrorType || {});
var ServiceError = class extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
    this.name = "ServiceError";
  }
};
var ErrorTypeToStatus = {
  ["VALIDATION" /* VALIDATION */]: 400,
  ["UNAUTHORIZED" /* UNAUTHORIZED */]: 401,
  ["FORBIDDEN" /* FORBIDDEN */]: 403,
  ["NOT_FOUND" /* NOT_FOUND */]: 404,
  ["CONFLICT" /* CONFLICT */]: 409,
  ["INTERNAL" /* INTERNAL */]: 500,
  ["UNKNOWN" /* UNKNOWN */]: 500
};
function createSuccessResponse(data) {
  return {
    success: true,
    data
  };
}
function createErrorResponse(type, message) {
  return {
    success: false,
    error: {
      type,
      message
    }
  };
}

// src/validation/openapi.ts
import { z } from "zod";
function createSuccessSchema(schema) {
  return z.object({
    success: z.literal(true),
    data: schema
  });
}
function createErrorSchema(type) {
  return z.object({
    success: z.literal(false),
    error: z.object({
      type: z.literal(type),
      message: z.string()
    })
  });
}
function createRouteResponse(successSchema, errorType, options = {}) {
  const {
    successStatus = 200,
    successDescription = "Successful response",
    errorDescription = "Error response"
  } = options;
  const responses = {
    [successStatus]: {
      description: successDescription,
      content: {
        "application/json": {
          schema: createSuccessSchema(successSchema)
        }
      }
    },
    [ErrorTypeToStatus[errorType]]: {
      description: errorDescription,
      content: {
        "application/json": {
          schema: createErrorSchema(errorType)
        }
      }
    }
  };
  return responses;
}

// src/validation/type-guards.ts
import { DomainSchema } from "@repo/schema";
function isError(value) {
  return value instanceof Error;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasProperty(obj, key) {
  return isPlainObject(obj) && key in obj;
}
function isUserData(data) {
  return DomainSchema.User.safeParse(data).success;
}
function isProjectData(data) {
  return DomainSchema.Project.safeParse(data).success;
}
function isTaskData(data) {
  return DomainSchema.Task.safeParse(data).success;
}
function createTypeGuard(schema) {
  return (data) => schema.safeParse(data).success;
}
function isRecordOf(value, itemGuard) {
  if (!isPlainObject(value))
    return false;
  return Object.values(value).every(itemGuard);
}
var createUserGuard = () => createTypeGuard(DomainSchema.User);
var createProjectGuard = () => createTypeGuard(DomainSchema.Project);
var createTaskGuard = () => createTypeGuard(DomainSchema.Task);
function isDurableObjectNamespace(value) {
  return isPlainObject(value) && "newUniqueId" in value && "idFromName" in value && "idFromString" in value;
}
function isKVNamespace(value) {
  return isPlainObject(value) && "get" in value && "put" in value && "delete" in value;
}
function isR2Bucket(value) {
  return isPlainObject(value) && "get" in value && "put" in value && "delete" in value && "head" in value;
}
function isD1Database(value) {
  return isPlainObject(value) && "prepare" in value && "batch" in value && "exec" in value;
}
function isFetcher(value) {
  return isPlainObject(value) && "fetch" in value;
}
function isQueue(value) {
  return isPlainObject(value) && "send" in value;
}

// src/validation/validators.ts
import { DomainSchema as DomainSchema2 } from "@repo/schema";
function validateWithSchema(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data
    };
  }
  return {
    success: false,
    error: result.error.message
  };
}
function validateUserData(data) {
  return validateWithSchema(DomainSchema2.User, data);
}
function validateProjectData(data) {
  return validateWithSchema(DomainSchema2.Project, data);
}
function validateTaskData(data) {
  return validateWithSchema(DomainSchema2.Task, data);
}
function createValidator(schema) {
  return (data) => validateWithSchema(schema, data);
}
var createUserValidator = () => createValidator(DomainSchema2.User);
var createProjectValidator = () => createValidator(DomainSchema2.Project);
var createTaskValidator = () => createValidator(DomainSchema2.Task);

// src/validation/schemas.ts
import { DomainSchema as DomainSchema3 } from "@repo/schema";
var {
  // Base schemas
  Entity: baseValidation,
  // User schemas
  User: userValidation,
  // Project schemas
  Project: projectValidation,
  ProjectSettings: projectSettingsValidation,
  // Task schemas
  Task: taskValidation
} = DomainSchema3;

// src/error/tracking.ts
import { z as z2 } from "zod";

// src/error/types.ts
var TypeErrorCategory = /* @__PURE__ */ ((TypeErrorCategory2) => {
  TypeErrorCategory2["VALIDATION"] = "validation";
  TypeErrorCategory2["SERIALIZATION"] = "serialization";
  TypeErrorCategory2["TYPE_SAFETY"] = "type_safety";
  return TypeErrorCategory2;
})(TypeErrorCategory || {});
var ErrorContext = /* @__PURE__ */ ((ErrorContext2) => {
  ErrorContext2["STORE_VALIDATION"] = "store_validation";
  ErrorContext2["STORE_INITIALIZATION"] = "store_initialization";
  ErrorContext2["WEBSOCKET_CONNECTION"] = "websocket_connection";
  ErrorContext2["WEBSOCKET_MESSAGE"] = "websocket_message";
  ErrorContext2["WEBSOCKET_BROADCAST"] = "websocket_broadcast";
  ErrorContext2["WEBSOCKET_ERROR"] = "websocket_error";
  ErrorContext2["WEBSOCKET_CLOSE"] = "websocket_close";
  return ErrorContext2;
})(ErrorContext || {});

// src/error/tracking.ts
var errorDetailsSchema = z2.object({
  category: z2.nativeEnum(TypeErrorCategory).optional(),
  operation: z2.string().optional(),
  table: z2.string().optional(),
  data: z2.unknown().optional(),
  path: z2.array(z2.union([z2.string(), z2.number()])).optional(),
  timestamp: z2.number().optional(),
  duration: z2.number().optional()
});
var errorTrackingConfigSchema = z2.object({
  enabled: z2.boolean(),
  sampleRate: z2.number().min(0).max(1).optional(),
  maxErrors: z2.number().int().positive().optional(),
  onError: z2.function().args(z2.custom()).returns(z2.void()).optional()
});
function initializeErrorCounters() {
  return Object.values(TypeErrorCategory).reduce((acc, category) => {
    acc[category] = 0;
    return acc;
  }, /* @__PURE__ */ Object.create(null));
}
var TypeSafetyTracker = class {
  errors = [];
  startTime = Date.now();
  validationTimes = [];
  config;
  constructor(config) {
    const validatedConfig = errorTrackingConfigSchema.parse(config);
    this.config = {
      enabled: validatedConfig.enabled,
      sampleRate: validatedConfig.sampleRate !== void 0 ? validatedConfig.sampleRate : 1,
      maxErrors: validatedConfig.maxErrors !== void 0 ? validatedConfig.maxErrors : 1e3,
      onError: validatedConfig.onError
    };
  }
  /**
   * Track a type safety error
   */
  trackError(category, operation, details = {}) {
    if (!this.config.enabled || Math.random() > (this.config.sampleRate || 1)) {
      return;
    }
    const baseContext = {
      category,
      operation,
      timestamp: Date.now()
    };
    const validatedDetails = errorDetailsSchema.safeParse(details);
    const context = {
      ...baseContext,
      ...validatedDetails.success ? validatedDetails.data : {}
    };
    this.errors.push(context);
    if (this.errors.length > (this.config.maxErrors || 1e3)) {
      this.errors.shift();
    }
    if (this.config.onError) {
      try {
        this.config.onError(context);
      } catch (error) {
        console.error("Error in onError callback:", error);
      }
    }
  }
  /**
   * Track validation performance
   */
  trackValidation(duration) {
    if (typeof duration !== "number" || isNaN(duration) || duration < 0) {
      console.warn("Invalid validation duration:", duration);
      return;
    }
    this.validationTimes.push(duration);
    if (this.validationTimes.length > 1e3) {
      this.validationTimes.shift();
    }
  }
  /**
   * Get current metrics
   */
  getMetrics() {
    const totalErrors = this.errors.length;
    const errorsByCategory = Object.values(TypeErrorCategory).reduce(
      (acc, category) => {
        acc[category] = this.errors.filter((e) => e.category === category).length;
        return acc;
      },
      initializeErrorCounters()
    );
    const avgValidationTime = this.validationTimes.length ? this.validationTimes.reduce((a, b) => a + b, 0) / this.validationTimes.length : 0;
    const timespan = Date.now() - this.startTime;
    const errorRate = totalErrors / (timespan / (1e3 * 60 * 60));
    return {
      totalErrors,
      errorsByCategory,
      averageValidationTime: avgValidationTime,
      errorRate,
      lastError: this.errors[this.errors.length - 1]
    };
  }
  /**
   * Get error history with type-safe filtering
   */
  getErrorHistory(options = {}) {
    const validatedOptions = {
      category: options.category,
      table: typeof options.table === "string" ? options.table : void 0,
      limit: typeof options.limit === "number" && options.limit > 0 ? options.limit : 100,
      since: typeof options.since === "number" ? options.since : 0
    };
    let filtered = this.errors;
    if (validatedOptions.category) {
      filtered = filtered.filter((e) => e.category === validatedOptions.category);
    }
    if (validatedOptions.table) {
      filtered = filtered.filter((e) => e.table === validatedOptions.table);
    }
    filtered = filtered.filter((e) => e.timestamp >= validatedOptions.since);
    return filtered.slice(-validatedOptions.limit);
  }
  /**
   * Clear error history
   */
  clearHistory() {
    this.errors = [];
    this.validationTimes = [];
    this.startTime = Date.now();
  }
};

// src/serialization/core/utils.ts
import { z as z3 } from "zod";
var dateSchema = z3.date();
var objectSchema = z3.record(z3.unknown());
function isDate(value) {
  return dateSchema.safeParse(value).success;
}
function isObject(value) {
  return objectSchema.safeParse(value).success;
}
function safeStringify(data, options = {}) {
  try {
    const serialized = JSON.stringify(data, (key, value) => {
      if (isDate(value)) {
        return { __type: "Date", value: value.toISOString() };
      }
      return value;
    }, options.pretty ? 2 : void 0);
    return { success: true, data: serialized };
  } catch (error) {
    const serializationError = {
      type: "serialization_error",
      message: error instanceof Error ? error.message : "Unknown serialization error",
      details: { data }
    };
    return { success: false, error: serializationError };
  }
}
function safeParse(data, validate) {
  try {
    const parsed = JSON.parse(data, (key, value) => {
      if (isObject(value) && value.__type === "Date") {
        const dateStr = value.value;
        if (typeof dateStr === "string") {
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) {
            return date;
          }
        }
      }
      return value;
    });
    if (validate) {
      if (!validate(parsed)) {
        const validationError2 = {
          type: "validation_error",
          message: "Data validation failed",
          details: { data: parsed }
        };
        return { success: false, error: validationError2 };
      }
      return { success: true, data: parsed };
    }
    const validationError = {
      type: "validation_error",
      message: "No validator provided for type checking",
      details: { data: parsed }
    };
    return { success: false, error: validationError };
  } catch (error) {
    const parseError = {
      type: "parse_error",
      message: error instanceof Error ? error.message : "Unknown parse error",
      details: { data }
    };
    return { success: false, error: parseError };
  }
}
function validateData(data, schema) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const validationError = {
      type: "validation_error",
      message: "Schema validation failed",
      details: { errors: result.error.errors }
    };
    return { success: false, error: validationError };
  }
  return { success: true, data: result.data };
}
function isValidData(data, schema) {
  return schema.safeParse(data).success;
}
export {
  ErrorContext,
  ErrorTypeToStatus,
  ServiceError,
  ServiceErrorType,
  TypeErrorCategory,
  TypeSafetyTracker,
  baseValidation,
  createErrorResponse,
  createErrorSchema,
  createProjectGuard,
  createProjectValidator,
  createRouteResponse,
  createSuccessResponse,
  createSuccessSchema,
  createTaskGuard,
  createTaskValidator,
  createTypeGuard,
  createUserGuard,
  createUserValidator,
  createValidator,
  hasProperty,
  isD1Database,
  isDate,
  isDurableObjectNamespace,
  isError,
  isFetcher,
  isKVNamespace,
  isObject,
  isPlainObject,
  isProjectData,
  isQueue,
  isR2Bucket,
  isRecordOf,
  isTaskData,
  isUserData,
  isValidData,
  projectSettingsValidation,
  projectValidation,
  safeParse,
  safeStringify,
  taskValidation,
  userValidation,
  validateData,
  validateProjectData,
  validateTaskData,
  validateUserData,
  validateWithSchema
};
//# sourceMappingURL=index.mjs.map

import { z } from 'zod';
import { createStore } from 'tinybase';

// src/schemas.ts

// src/enums.ts
var UserRole = /* @__PURE__ */ ((UserRole2) => {
  UserRole2["ADMIN"] = "admin";
  UserRole2["MEMBER"] = "member";
  UserRole2["GUEST"] = "guest";
  return UserRole2;
})(UserRole || {});
var ProjectStatus = /* @__PURE__ */ ((ProjectStatus2) => {
  ProjectStatus2["ACTIVE"] = "active";
  ProjectStatus2["ARCHIVED"] = "archived";
  ProjectStatus2["DRAFT"] = "draft";
  return ProjectStatus2;
})(ProjectStatus || {});
var TaskStatus = /* @__PURE__ */ ((TaskStatus2) => {
  TaskStatus2["TODO"] = "todo";
  TaskStatus2["IN_PROGRESS"] = "in_progress";
  TaskStatus2["REVIEW"] = "review";
  TaskStatus2["DONE"] = "done";
  return TaskStatus2;
})(TaskStatus || {});
var TaskPriority = /* @__PURE__ */ ((TaskPriority2) => {
  TaskPriority2["LOW"] = "low";
  TaskPriority2["MEDIUM"] = "medium";
  TaskPriority2["HIGH"] = "high";
  TaskPriority2["URGENT"] = "urgent";
  return TaskPriority2;
})(TaskPriority || {});

// src/schemas.ts
var baseSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number().min(0)
});
var userSyncableSchema = baseSchema.extend({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.nativeEnum(UserRole),
  avatar: z.string().url().optional(),
  lastActive: z.number()
});
var userPostgresOnlySchema = z.object({
  passwordHash: z.string(),
  failedLoginAttempts: z.number(),
  lastLoginIp: z.string().optional(),
  verificationToken: z.string().optional(),
  resetPasswordToken: z.string().optional(),
  lastPasswordChange: z.number().optional(),
  emailVerified: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
var userCompleteSchema = userSyncableSchema.merge(userPostgresOnlySchema);
var projectSyncableSchema = baseSchema.extend({
  name: z.string().min(1),
  description: z.string(),
  status: z.nativeEnum(ProjectStatus),
  ownerId: z.string().uuid(),
  settings: z.object({
    isPublic: z.boolean(),
    allowGuests: z.boolean()
  })
});
var projectPostgresOnlySchema = z.object({
  deletedAt: z.number().optional(),
  archivedReason: z.string().optional(),
  lastBackupAt: z.number().optional(),
  auditLog: z.array(z.object({
    action: z.string(),
    userId: z.string(),
    timestamp: z.number(),
    details: z.record(z.string(), z.unknown())
  })).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
var projectCompleteSchema = projectSyncableSchema.merge(projectPostgresOnlySchema);
var taskSyncableSchema = baseSchema.extend({
  title: z.string().min(1),
  description: z.string(),
  status: z.nativeEnum(TaskStatus),
  priority: z.nativeEnum(TaskPriority),
  projectId: z.string().uuid(),
  assigneeId: z.string().uuid(),
  dueDate: z.number().optional(),
  completedAt: z.number().optional(),
  tags: z.array(z.string())
});
var taskPostgresOnlySchema = z.object({
  timeTracking: z.array(z.object({
    startTime: z.number(),
    endTime: z.number().optional(),
    userId: z.string()
  })).optional(),
  comments: z.array(z.object({
    id: z.string(),
    content: z.string(),
    userId: z.string(),
    createdAt: z.number(),
    editedAt: z.number().optional()
  })).optional(),
  history: z.array(z.object({
    field: z.string(),
    oldValue: z.unknown(),
    newValue: z.unknown(),
    userId: z.string(),
    timestamp: z.number()
  })).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
var taskCompleteSchema = taskSyncableSchema.merge(taskPostgresOnlySchema);
function isDate(value) {
  return value instanceof Date && !isNaN(value.getTime());
}
function toTinyBase(data, options = {}) {
  try {
    return Object.entries(data).reduce((acc, [key, value]) => {
      if (Array.isArray(value) || typeof value === "object" && value !== null) {
        acc[key] = JSON.stringify(value);
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
  } catch (error) {
    const validationError = {
      path: [],
      message: error instanceof Error ? error.message : "Serialization failed",
      code: "invalid_type"
    };
    options.onError?.(validationError);
    if (options.strict) {
      throw error;
    }
    return {};
  }
}
function fromTinyBase(data, schema, options = {}) {
  try {
    const parsed = Object.entries(data).reduce((acc, [key, value]) => {
      if (typeof value === "string") {
        try {
          acc[key] = JSON.parse(value);
        } catch {
          acc[key] = value;
        }
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      error.errors.forEach((err) => {
        const validationError = {
          path: err.path,
          message: err.message,
          code: "invalid_value"
        };
        options.onError?.(validationError);
      });
    }
    if (options.strict) {
      throw error;
    }
    return {};
  }
}
function isValidData(data, schema) {
  try {
    schema.parse(data);
    return true;
  } catch {
    return false;
  }
}
function validateData(data, schema, options = {}) {
  try {
    schema.parse(data);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map((err) => ({
        path: err.path,
        message: err.message,
        code: "invalid_value"
      }));
      errors.forEach((err) => options.onError?.(err));
      return { valid: false, errors };
    }
    return {
      valid: false,
      errors: [{
        path: [],
        message: error instanceof Error ? error.message : "Unknown validation error",
        code: "invalid_type"
      }]
    };
  }
}
function toPostgres(data, options = {}) {
  try {
    return Object.entries(data).reduce((acc, [key, value]) => {
      if (isDate(value)) {
        acc[key] = value.toISOString();
      } else if (Array.isArray(value) || typeof value === "object" && value !== null) {
        const jsonValue = JSON.parse(JSON.stringify(value));
        acc[key] = jsonValue;
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
  } catch (error) {
    const validationError = {
      path: [],
      message: error instanceof Error ? error.message : "PostgreSQL serialization failed",
      code: "invalid_type"
    };
    options.onError?.(validationError);
    if (options.strict) {
      throw error;
    }
    return {};
  }
}
function fromPostgres(data, schema, options = {}) {
  try {
    const parsed = Object.entries(data).reduce((acc, [key, value]) => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        acc[key] = new Date(value);
      } else if (typeof value === "object" && value !== null) {
        acc[key] = value;
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      error.errors.forEach((err) => {
        const validationError = {
          path: err.path,
          message: err.message,
          code: "invalid_value"
        };
        options.onError?.(validationError);
      });
    }
    if (options.strict) {
      throw error;
    }
    return {};
  }
}

// src/error-tracking.ts
var TypeErrorCategory = /* @__PURE__ */ ((TypeErrorCategory2) => {
  TypeErrorCategory2["SCHEMA_VALIDATION"] = "schema_validation";
  TypeErrorCategory2["SERIALIZATION"] = "serialization";
  TypeErrorCategory2["TYPE_CONVERSION"] = "type_conversion";
  TypeErrorCategory2["RUNTIME_MISMATCH"] = "runtime_mismatch";
  return TypeErrorCategory2;
})(TypeErrorCategory || {});
var TypeSafetyTracker = class {
  constructor(config) {
    this.errors = [];
    this.startTime = Date.now();
    this.validationTimes = [];
    this.config = {
      sampleRate: 1,
      maxErrors: 1e3,
      ...config
    };
  }
  /**
   * Track a type safety error
   */
  trackError(category, operation, details = {}) {
    if (!this.config.enabled || Math.random() > (this.config.sampleRate || 1)) {
      return;
    }
    const context = {
      category,
      operation,
      timestamp: Date.now(),
      ...details
    };
    this.errors.push(context);
    if (this.errors.length > (this.config.maxErrors || 1e3)) {
      this.errors.shift();
    }
    this.config.onError?.(context);
  }
  /**
   * Track validation performance
   */
  trackValidation(duration) {
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
      {}
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
   * Get error history
   */
  getErrorHistory(options = {}) {
    let filtered = this.errors;
    if (options.category) {
      filtered = filtered.filter((e) => e.category === options.category);
    }
    if (options.table) {
      filtered = filtered.filter((e) => e.table === options.table);
    }
    filtered = filtered.filter((e) => e.timestamp >= (options.since ?? 0));
    return filtered.slice(-(options.limit || 100));
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
var TypedStore = class {
  constructor(schema, options = {}, errorTracking = { enabled: true }, config = {}) {
    this.store = createStore();
    this.schema = schema;
    this.options = options;
    this.errorTracker = new TypeSafetyTracker(errorTracking);
    this.config = {
      strict: true,
      ...config
    };
  }
  /**
   * Set data with type validation
   */
  set(tableId, rowId, data) {
    const start = performance.now();
    try {
      const serialized = toTinyBase(data, {
        ...this.options,
        onError: (error) => {
          this.options.onError?.(error);
          this.errorTracker.trackError("serialization" /* SERIALIZATION */, "set", {
            table: tableId,
            data,
            path: error.path
          });
        }
      });
      const row = Object.entries(serialized).reduce((acc, [key, value]) => {
        if (value !== null) {
          acc[key] = value;
        }
        return acc;
      }, {});
      this.store.setRow(tableId, rowId, row);
      this.errorTracker.trackValidation(performance.now() - start);
    } catch (error) {
      this.errorTracker.trackError("runtime_mismatch" /* RUNTIME_MISMATCH */, "set", {
        table: tableId,
        data,
        duration: performance.now() - start
      });
      throw error;
    }
  }
  /**
   * Get data with type validation
   */
  get(tableId, rowId) {
    const start = performance.now();
    try {
      const data = this.store.getRow(tableId, rowId);
      if (!data) return null;
      const result = fromTinyBase(data, this.schema, {
        ...this.options,
        onError: (error) => {
          this.options.onError?.(error);
          this.errorTracker.trackError("type_conversion" /* TYPE_CONVERSION */, "get", {
            table: tableId,
            data,
            path: error.path
          });
        }
      });
      this.errorTracker.trackValidation(performance.now() - start);
      return result;
    } catch (error) {
      this.errorTracker.trackError("runtime_mismatch" /* RUNTIME_MISMATCH */, "get", {
        table: tableId,
        duration: performance.now() - start
      });
      throw error;
    }
  }
  /**
   * Get all rows from a table
   */
  getAll(tableId) {
    const start = performance.now();
    try {
      const table = this.store.getTable(tableId);
      const result = Object.entries(table).reduce((acc, [rowId, data]) => {
        acc[rowId] = fromTinyBase(data, this.schema, {
          ...this.options,
          onError: (error) => {
            this.options.onError?.(error);
            this.errorTracker.trackError("type_conversion" /* TYPE_CONVERSION */, "getAll", {
              table: tableId,
              data,
              path: error.path
            });
          }
        });
        return acc;
      }, {});
      this.errorTracker.trackValidation(performance.now() - start);
      return result;
    } catch (error) {
      this.errorTracker.trackError("runtime_mismatch" /* RUNTIME_MISMATCH */, "getAll", {
        table: tableId,
        duration: performance.now() - start
      });
      throw error;
    }
  }
  /**
   * Delete a row
   */
  delete(tableId, rowId) {
    this.store.delRow(tableId, rowId);
  }
  /**
   * Add a listener for changes to a table
   * @returns A function that removes the listener when called
   */
  addListener(tableId, callback) {
    const listener = () => {
      const data = this.getAll(tableId);
      callback(data);
    };
    const listenerId = this.store.addTableListener(tableId, listener);
    return () => {
      this.store.delListener(listenerId);
    };
  }
  /**
   * Get the underlying TinyBase store
   */
  getStore() {
    return this.store;
  }
  /**
   * Validate all data in a table
   */
  validateTable(tableId) {
    const start = performance.now();
    const errors = [];
    try {
      const table = this.store.getTable(tableId);
      Object.entries(table).forEach(([rowId, data]) => {
        try {
          fromTinyBase(data, this.schema, {
            ...this.options,
            onError: (error) => {
              errors.push(error);
              this.errorTracker.trackError("schema_validation" /* SCHEMA_VALIDATION */, "validateTable", {
                table: tableId,
                data,
                path: error.path
              });
            }
          });
        } catch (error) {
          this.errorTracker.trackError("schema_validation" /* SCHEMA_VALIDATION */, "validateTable", {
            table: tableId,
            data
          });
        }
      });
      this.errorTracker.trackValidation(performance.now() - start);
      return errors;
    } catch (error) {
      this.errorTracker.trackError("runtime_mismatch" /* RUNTIME_MISMATCH */, "validateTable", {
        table: tableId,
        duration: performance.now() - start
      });
      throw error;
    }
  }
  /**
   * Get error tracking metrics
   */
  getErrorMetrics() {
    return this.errorTracker.getMetrics();
  }
  /**
   * Get error history
   */
  getErrorHistory(options = {}) {
    return this.errorTracker.getErrorHistory(options);
  }
  validate(data) {
    try {
      return this.schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const validationError = {
          message: error.errors[0]?.message || "Validation failed",
          path: error.errors[0]?.path || [],
          code: "invalid_value"
        };
        this.config.onError?.(validationError);
      }
      if (this.config.strict) {
        throw error;
      }
      return undefined;
    }
  }
};

// src/cloudflare-do.ts
var TypedDurableObject = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  /**
   * Handle HTTP requests
   */
  async fetch(request) {
    try {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader?.toLowerCase() === "websocket") {
        return this.handleWebSocket(request);
      }
      return this.handleRequest(request);
    } catch (error) {
      console.error("Error in fetch:", error);
      return new Response("Internal Error", { status: 500 });
    }
  }
  /**
   * Handle WebSocket connections
   */
  async handleWebSocket(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", async (event) => {
      try {
        await this.handleWebSocketMessage(server, event);
      } catch (error) {
        console.error("Error in WebSocket message:", error);
        server.close(1011, "Internal Error");
      }
    });
    server.addEventListener("close", (event) => {
      this.handleWebSocketClose(server, event);
    });
    server.addEventListener("error", (event) => {
      this.handleWebSocketError(server, event);
    });
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  /**
   * Handle WebSocket close
   */
  handleWebSocketClose(ws, event) {
  }
  /**
   * Handle WebSocket errors
   */
  handleWebSocketError(ws, event) {
    console.error("WebSocket error:", event);
  }
  /**
   * Helper to run code with concurrency control
   */
  async withConcurrencyControl(callback) {
    return this.state.blockConcurrencyWhile(async () => {
      return callback();
    });
  }
  /**
   * Helper to run code in a transaction
   */
  async withTransaction(callback) {
    return this.state.storage.transaction(callback);
  }
  /**
   * Helper to store data
   */
  async store(key, value) {
    await this.state.storage.put(key, value);
  }
  /**
   * Helper to retrieve data
   */
  async retrieve(key) {
    return this.state.storage.get(key);
  }
  /**
   * Helper to delete data
   */
  async remove(key) {
    return this.state.storage.delete(key);
  }
};

// src/cloudflare-worker.ts
var TypedWorker = class {
  constructor(env) {
    this.env = env;
  }
  /**
   * Handle fetch events
   */
  async fetch(request, env, ctx) {
    try {
      if (this.shouldPassThroughErrors(request)) {
        ctx.passThroughOnException();
      }
      return await this.handleRequest(request, env, ctx);
    } catch (error) {
      return this.handleError(error);
    }
  }
  /**
   * Handle scheduled events
   */
  async scheduled(controller, env, ctx) {
    try {
      await this.handleScheduled(controller, env, ctx);
    } catch (error) {
      console.error("Error in scheduled event:", error);
      throw error;
    }
  }
  /**
   * Handle queue messages
   */
  async queue(batch, env, ctx) {
    try {
      await this.handleQueue(batch, env, ctx);
    } catch (error) {
      console.error("Error processing queue:", error);
      throw error;
    }
  }
  /**
   * Handle scheduled events (optional override)
   */
  async handleScheduled(controller, env, ctx) {
  }
  /**
   * Handle queue messages (optional override)
   */
  async handleQueue(batch, env, ctx) {
  }
  /**
   * Handle errors
   */
  handleError(error) {
    console.error("Worker error:", error);
    return new Response("Internal Error", { status: 500 });
  }
  /**
   * Determine if errors should be passed through
   */
  shouldPassThroughErrors(request) {
    return false;
  }
  /**
   * Helper to wait for async tasks
   */
  waitUntil(ctx, promise) {
    ctx.waitUntil(promise.catch((error) => {
      console.error("Background task error:", error);
    }));
  }
  /**
   * Helper to create JSON responses
   */
  json(data, init) {
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        ...init?.headers || {}
      },
      ...init
    });
  }
  /**
   * Helper to parse JSON requests
   */
  async parseJson(request) {
    const contentType = request.headers.get("Content-Type");
    if (!contentType?.includes("application/json")) {
      throw new Error("Expected JSON content type");
    }
    return request.json();
  }
  /**
   * Helper to validate request method
   */
  validateMethod(request, allowedMethods) {
    if (!allowedMethods.includes(request.method)) {
      throw new Error(`Method ${request.method} not allowed`);
    }
  }
};

export { TypeErrorCategory, TypeSafetyTracker, TypedDurableObject, TypedStore, TypedWorker, baseSchema, fromPostgres, fromTinyBase, isValidData, projectCompleteSchema, projectPostgresOnlySchema, projectSyncableSchema, taskCompleteSchema, taskPostgresOnlySchema, taskSyncableSchema, toPostgres, toTinyBase, userCompleteSchema, userPostgresOnlySchema, userSyncableSchema, validateData };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map
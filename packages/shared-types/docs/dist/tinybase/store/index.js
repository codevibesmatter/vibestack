"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypedStore = void 0;
const tinybase_1 = require("tinybase");
const tracking_1 = require("../../error/tracking");
const validation_1 = require("./validation");
const transformation_1 = require("./transformation");
/**
 * Type-safe wrapper around TinyBase store
 */
class TypedStore {
    constructor(schema, options = {}, errorTracking = { enabled: true }, config = {}) {
        this.store = (0, tinybase_1.createStore)();
        const errorTracker = new tracking_1.TypeSafetyTracker(errorTracking);
        this.validationHandler = new validation_1.ValidationHandler(schema, errorTracker, options);
        this.transformationHandler = new transformation_1.TransformationHandler(this.validationHandler);
    }
    /**
     * Set data with type validation
     */
    set(tableId, rowId, data) {
        const start = performance.now();
        const context = { operation: 'set', table: tableId, start };
        const row = this.transformationHandler.toRow(data, context);
        this.store.setRow(tableId, rowId, row);
    }
    /**
     * Get data with type validation
     */
    get(tableId, rowId) {
        const start = performance.now();
        const context = { operation: 'get', table: tableId, start };
        const data = this.store.getRow(tableId, rowId);
        if (!data)
            return null;
        return this.transformationHandler.fromRow(data, context);
    }
    /**
     * Get all rows from a table
     */
    getAll(tableId) {
        const start = performance.now();
        const context = { operation: 'getAll', table: tableId, start };
        const table = this.store.getTable(tableId);
        return this.transformationHandler.fromTable(table, context);
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
        const context = { operation: 'validateTable', table: tableId, start };
        const table = this.store.getTable(tableId);
        this.transformationHandler.fromTable(table, context);
    }
}
exports.TypedStore = TypedStore;

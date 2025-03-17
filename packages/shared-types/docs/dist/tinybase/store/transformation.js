"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransformationHandler = void 0;
const tinybase_1 = require("../../serialization/tinybase");
class TransformationHandler {
    constructor(validationHandler) {
        this.validationHandler = validationHandler;
    }
    toRow(data, context) {
        try {
            const serialized = (0, tinybase_1.toTinyBase)(data);
            // Convert to TinyBase Row type (exclude null values)
            return Object.entries(serialized).reduce((acc, [key, value]) => {
                if (value !== null) {
                    acc[key] = value;
                }
                return acc;
            }, {});
        }
        catch (error) {
            this.validationHandler.handleRuntimeError(error, {
                ...context,
                data
            });
            throw error;
        }
    }
    fromRow(data, context) {
        try {
            return this.validationHandler.validateData(data, context);
        }
        catch (error) {
            this.validationHandler.handleRuntimeError(error, {
                ...context,
                data
            });
            throw error;
        }
    }
    fromTable(table, context) {
        return Object.entries(table).reduce((acc, [rowId, data]) => {
            acc[rowId] = this.fromRow(data, context);
            return acc;
        }, {});
    }
}
exports.TransformationHandler = TransformationHandler;

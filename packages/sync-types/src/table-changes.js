"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTableChange = isTableChange;
// Type guards for message handling
function isTableChange(payload) {
    var p = payload;
    return p
        && typeof p.table === 'string'
        && ['insert', 'update', 'delete'].includes(p.operation)
        && typeof p.data === 'object'
        && p.data !== null
        && typeof p.updated_at === 'string';
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTableChange = isTableChange;
exports.isClientMessageType = isClientMessageType;
// Type guards
function isTableChange(payload) {
    var p = payload;
    return p
        && typeof p.table === 'string'
        && ['insert', 'update', 'delete'].includes(p.operation)
        && typeof p.data === 'object'
        && p.data !== null
        && (!p.lsn || typeof p.lsn === 'string') // LSN is optional
        && typeof p.updated_at === 'string';
}
function isClientMessageType(type) {
    return type.startsWith('clt_');
}

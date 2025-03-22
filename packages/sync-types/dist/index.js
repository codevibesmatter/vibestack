var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  isClientMessageType: () => isClientMessageType,
  isTableChange: () => isTableChange
});
module.exports = __toCommonJS(index_exports);
function isTableChange(payload) {
  const p = payload;
  return p && typeof p.table === "string" && ["insert", "update", "delete"].includes(p.operation) && typeof p.data === "object" && p.data !== null && (!p.lsn || typeof p.lsn === "string") && typeof p.updated_at === "string";
}
function isClientMessageType(type) {
  return type.startsWith("clt_");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isClientMessageType,
  isTableChange
});

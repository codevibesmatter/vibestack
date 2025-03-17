// src/index.ts
function isTableChange(payload) {
  const p = payload;
  return p && typeof p.table === "string" && ["insert", "update", "delete"].includes(p.operation) && typeof p.data === "object" && p.data !== null && typeof p.lsn === "string" && typeof p.updated_at === "string";
}
export {
  isTableChange
};

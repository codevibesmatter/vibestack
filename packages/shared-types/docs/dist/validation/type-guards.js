"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTaskGuard = exports.createProjectGuard = exports.createUserGuard = void 0;
exports.isUserData = isUserData;
exports.isProjectData = isProjectData;
exports.isTaskData = isTaskData;
exports.createTypeGuard = createTypeGuard;
const schemas_1 = require("../domain/schemas");
/**
 * Type guard for UserSyncable
 * @param data Unknown data to check
 * @returns Type predicate indicating if data is UserSyncable
 */
function isUserData(data) {
    return schemas_1.userSyncableSchema.safeParse(data).success;
}
/**
 * Type guard for ProjectSyncable
 * @param data Unknown data to check
 * @returns Type predicate indicating if data is ProjectSyncable
 */
function isProjectData(data) {
    return schemas_1.projectSyncableSchema.safeParse(data).success;
}
/**
 * Type guard for TaskSyncable
 * @param data Unknown data to check
 * @returns Type predicate indicating if data is TaskSyncable
 */
function isTaskData(data) {
    return schemas_1.taskSyncableSchema.safeParse(data).success;
}
/**
 * Generic type guard for Zod schema
 * @param schema Zod schema to validate against
 * @returns Type guard function for the schema type
 */
function createTypeGuard(schema) {
    return (data) => {
        return schema.safeParse(data).success;
    };
}
// Export type guard creators for reuse
const createUserGuard = () => createTypeGuard(schemas_1.userSyncableSchema);
exports.createUserGuard = createUserGuard;
const createProjectGuard = () => createTypeGuard(schemas_1.projectSyncableSchema);
exports.createProjectGuard = createProjectGuard;
const createTaskGuard = () => createTypeGuard(schemas_1.taskSyncableSchema);
exports.createTaskGuard = createTaskGuard;

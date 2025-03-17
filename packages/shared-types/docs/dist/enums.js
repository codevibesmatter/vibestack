"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskPriority = exports.TaskStatus = exports.ProjectStatus = exports.UserRole = void 0;
var UserRole;
(function (UserRole) {
    UserRole["ADMIN"] = "admin";
    UserRole["MEMBER"] = "member";
    UserRole["GUEST"] = "guest";
})(UserRole || (exports.UserRole = UserRole = {}));
var ProjectStatus;
(function (ProjectStatus) {
    ProjectStatus["ACTIVE"] = "active";
    ProjectStatus["ARCHIVED"] = "archived";
    ProjectStatus["DRAFT"] = "draft";
})(ProjectStatus || (exports.ProjectStatus = ProjectStatus = {}));
var TaskStatus;
(function (TaskStatus) {
    TaskStatus["TODO"] = "todo";
    TaskStatus["IN_PROGRESS"] = "in_progress";
    TaskStatus["REVIEW"] = "review";
    TaskStatus["DONE"] = "done";
})(TaskStatus || (exports.TaskStatus = TaskStatus = {}));
var TaskPriority;
(function (TaskPriority) {
    TaskPriority["LOW"] = "low";
    TaskPriority["MEDIUM"] = "medium";
    TaskPriority["HIGH"] = "high";
    TaskPriority["URGENT"] = "urgent";
})(TaskPriority || (exports.TaskPriority = TaskPriority = {}));

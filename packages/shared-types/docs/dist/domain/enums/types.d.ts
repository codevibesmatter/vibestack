export declare enum UserRole {
    ADMIN = "admin",
    MEMBER = "member",
    GUEST = "guest"
}
export declare enum ProjectStatus {
    ACTIVE = "active",
    ARCHIVED = "archived",
    DRAFT = "draft"
}
export declare enum TaskStatus {
    TODO = "todo",
    IN_PROGRESS = "in_progress",
    REVIEW = "review",
    DONE = "done"
}
export declare enum TaskPriority {
    LOW = "low",
    MEDIUM = "medium",
    HIGH = "high",
    URGENT = "urgent"
}
export type { UserRole as UserRoleType };
export type { ProjectStatus as ProjectStatusType };
export type { TaskStatus as TaskStatusType };
export type { TaskPriority as TaskPriorityType };

import { UserRole } from '../enums';
import { BaseSchema } from '../schemas/base';
/**
 * User schema interface
 */
export interface UserSchema extends BaseSchema {
    email: string;
    name: string;
    role: UserRole;
    avatar?: string;
    lastActive: number;
}
/**
 * User authentication data
 */
export interface UserAuthData {
    email: string;
    passwordHash: string;
    failedLoginAttempts: number;
    lastLoginIp?: string;
    verificationToken?: string;
    resetPasswordToken?: string;
    lastPasswordChange?: number;
    emailVerified: boolean;
}
/**
 * User preferences
 */
export interface UserPreferences {
    theme: 'light' | 'dark' | 'system';
    notifications: {
        email: boolean;
        push: boolean;
        desktop: boolean;
    };
    timezone: string;
    language: string;
}
/**
 * User session data
 */
export interface UserSession {
    id: string;
    userId: string;
    token: string;
    createdAt: number;
    expiresAt: number;
    lastActivity: number;
    ipAddress: string;
    userAgent: string;
}
/**
 * User activity log entry
 */
export interface UserActivity {
    id: string;
    userId: string;
    type: string;
    timestamp: number;
    details: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}

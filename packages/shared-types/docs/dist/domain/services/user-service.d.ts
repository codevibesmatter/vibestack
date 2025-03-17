import { UserSchema } from '../user';
import { BaseSchema } from '../schemas/base';
/**
 * User creation operation data
 */
export interface UserCreationOperation extends Omit<UserSchema, keyof BaseSchema> {
    password: string;
}
/**
 * User update operation data
 */
export interface UserUpdateOperation extends Partial<Omit<UserSchema, keyof BaseSchema>> {
    password?: string;
}
/**
 * User authentication operation
 */
export interface UserAuthOperation {
    email: string;
    password: string;
}
/**
 * Password reset operation
 */
export interface PasswordResetOperation {
    token: string;
    newPassword: string;
}
/**
 * Email verification operation
 */
export interface EmailVerificationOperation {
    token: string;
}

import 'reflect-metadata';

// Define a unique key for the metadata
export const ENUM_TYPE_NAME_METADATA_KEY = Symbol('enumTypeName');

/**
 * Decorator to explicitly store the TypeScript enum type name as metadata.
 *
 * Usage:
 * ```
 * @Column({ type: "enum", enum: MyEnum })
 * @EnumTypeName('MyEnum')
 * status!: MyEnum;
 * ```
 *
 * @param enumName The string name of the Enum type.
 */
export function EnumTypeName(enumName: string): PropertyDecorator {
    return (target: Object, propertyKey: string | symbol) => {
        Reflect.defineMetadata(ENUM_TYPE_NAME_METADATA_KEY, enumName, target, propertyKey);
    };
}

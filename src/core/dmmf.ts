import fs from 'fs';
import path from 'path';
import type { DMMF, DMMFModel, DMMFField, RelationConfig } from '../types';

let _dmmf: DMMF | null = null;
let _dmmfPromise: Promise<DMMF> | null = null;

/**
 * Load and cache the full DMMF from the Prisma schema.
 * Uses @prisma/internals for complete DMMF including:
 * isId, isList, isRequired, relationFromFields, relationToFields, primaryKey
 */
export async function loadDMMF(): Promise<DMMF> {
    if (_dmmf) return _dmmf;
    if (_dmmfPromise) return _dmmfPromise;

    _dmmfPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getDMMF } = require('@prisma/internals');
        const schemaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        _dmmf = await getDMMF({ datamodel: schema });
        return _dmmf!;
    })();

    return _dmmfPromise;
}

/**
 * Get cached DMMF synchronously (must call loadDMMF first)
 */
export function getDMMFSync(): DMMF | null {
    return _dmmf;
}

/**
 * Get a model from the DMMF by name
 */
export function getModel(modelName: string): DMMFModel | undefined {
    if (!_dmmf) {
        throw new Error('DMMF not loaded. Call loadDMMF() first.');
    }
    return _dmmf.datamodel.models.find((m: DMMFModel) => m.name === modelName);
}

/**
 * Get all fields for a model (including relation fields)
 */
export function getFields(modelName: string): Record<string, DMMFField> {
    const model = getModel(modelName);
    if (!model) return {};
    return model.fields.reduce((acc: Record<string, DMMFField>, field: DMMFField) => {
        acc[field.name] = field;
        return acc;
    }, {});
}

/**
 * Get only scalar fields for a model (excludes relation fields)
 */
export function getScalarFields(modelName: string): Record<string, DMMFField> {
    const model = getModel(modelName);
    if (!model) return {};
    return model.fields
        .filter((field: DMMFField) => field.kind !== 'object')
        .reduce((acc: Record<string, DMMFField>, field: DMMFField) => {
            acc[field.name] = field;
            return acc;
        }, {});
}

/**
 * Get the primary key field(s) for a model
 */
export function getPrimaryKey(modelName: string): string | string[] {
    const model = getModel(modelName);
    if (!model) return 'id';

    if (model.primaryKey?.fields && model.primaryKey.fields.length > 0) {
        return model.primaryKey.fields.length === 1
            ? model.primaryKey.fields[0]
            : model.primaryKey.fields;
    }

    const idField = model.fields.find((f: DMMFField) => f.isId);
    return idField ? idField.name : 'id';
}

/**
 * Get all relation fields for a model
 */
export function getRelations(modelName: string): DMMFField[] {
    const model = getModel(modelName);
    if (!model) return [];
    return model.fields.filter((f: DMMFField) => f.kind === 'object');
}

/**
 * Check if a field is a list relation
 */
export function isListRelation(modelName: string, fieldName: string): boolean {
    const model = getModel(modelName);
    if (!model) return false;
    const field = model.fields.find((f: DMMFField) => f.name === fieldName);
    return field?.isList === true;
}

/**
 * Get relationship info for a relation field
 */
export function getRelationInfo(
    modelName: string,
    relationName: string
): { name: string; targetModel: string; isList: boolean; fromFields: string[]; toFields: string[]; onDelete?: string } | null {
    const model = getModel(modelName);
    if (!model) return null;

    const field = model.fields.find((f: DMMFField) => f.name === relationName && f.kind === 'object');
    if (!field) return null;

    return {
        name: field.name,
        targetModel: field.type,
        isList: field.isList,
        fromFields: field.relationFromFields || [],
        toFields: field.relationToFields || [],
        onDelete: field.relationOnDelete as string | undefined,
    };
}

// =====================================================
// AUTO-DETECTION HELPERS
// =====================================================

const USER_MODEL_NAMES = ['user', 'users', 'account', 'accounts'];
const PASSWORD_FIELD_NAMES = ['password', 'hash', 'passwordhash', 'password_hash', 'passwd', 'pwd', 'hashed_password'];

/**
 * Find a user-like model by common naming conventions
 */
export function findUserModel(): DMMFModel | null {
    if (!_dmmf) return null;
    for (const name of USER_MODEL_NAMES) {
        const model = _dmmf.datamodel.models.find(
            (m: DMMFModel) => m.name.toLowerCase() === name
        );
        if (model) return model;
    }
    return null;
}

/**
 * Find unique scalar string fields suitable as login identifiers
 */
export function findIdentifierFields(modelName: string): string[] {
    const fields = getScalarFields(modelName);
    const result: string[] = [];

    for (const [name, field] of Object.entries(fields)) {
        if (field.isUnique && field.type === 'String' && !field.isId) {
            const lower = name.toLowerCase();
            if (!PASSWORD_FIELD_NAMES.includes(lower)) {
                result.push(name);
            }
        }
    }

    return result.length > 0 ? result : ['email'];
}

/**
 * Find the password field by common naming conventions
 */
export function findPasswordField(modelName: string): string | null {
    const fields = getScalarFields(modelName);

    for (const [name] of Object.entries(fields)) {
        if (PASSWORD_FIELD_NAMES.includes(name.toLowerCase())) {
            return name;
        }
    }

    return null;
}

// =====================================================
// RELATIONSHIP BUILDING
// =====================================================

/**
 * Build relationships configuration for a model (replaces relationships.json)
 */
export function buildRelationships(modelName: string): RelationConfig[] {
    const relations = getRelations(modelName);

    return relations.map((rel: DMMFField) => {
        const config: RelationConfig = {
            name: rel.name,
            object: rel.type,
            isList: rel.isList,
        };

        if (rel.relationFromFields && rel.relationFromFields.length > 0) {
            config.field = rel.relationFromFields[0];
            config.foreignKey = rel.relationToFields?.[0] || 'id';

            if (rel.relationFromFields.length > 1) {
                config.fields = rel.relationFromFields;
                config.foreignKeys = rel.relationToFields;
            }
        }

        const targetRelations = getRelations(rel.type);
        if (targetRelations.length > 0) {
            config.relation = targetRelations.map((nested: DMMFField) => ({
                name: nested.name,
                object: nested.type,
                isList: nested.isList,
                field: nested.relationFromFields?.[0],
                foreignKey: nested.relationToFields?.[0] || 'id',
            }));
        }

        return config;
    });
}

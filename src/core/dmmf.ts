import fs from 'fs';
import path from 'path';
import type { DMMF, DMMFModel, DMMFField, RelationConfig } from '../types';

let _dmmf: DMMF | null = null;
let _dmmfPromise: Promise<DMMF> | null = null;

// Per-model memoization — the schema is immutable for the process lifetime and these
// helpers run many times per request (filter navigation, include building, sort
// validation, write transforms). Cleared when the DMMF is (re)loaded.
const _modelCache = new Map<string, DMMFModel | undefined>();
const _fieldsCache = new Map<string, Record<string, DMMFField>>();
const _scalarFieldsCache = new Map<string, Record<string, DMMFField>>();
const _primaryKeyCache = new Map<string, string | string[]>();
const _relationshipsCache = new Map<string, RelationConfig[]>();

function clearModelCaches(): void {
    _modelCache.clear();
    _fieldsCache.clear();
    _scalarFieldsCache.clear();
    _primaryKeyCache.clear();
    _relationshipsCache.clear();
}

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
        clearModelCaches();
        return _dmmf!;
    })();

    return _dmmfPromise;
}

/** Forget the loaded DMMF — the next loadDMMF() reads the schema again (setup wizard, tests) */
export function resetDMMF(): void {
    _dmmf = null;
    _dmmfPromise = null;
    clearModelCaches();
}

/**
 * Get cached DMMF synchronously (must call loadDMMF first)
 */
export function getDMMFSync(): DMMF | null {
    return _dmmf;
}

/** An enum's values — null when the DMMF doesn't know the enum */
export function getEnumValues(enumName: string): string[] | null {
    const enums = (_dmmf?.datamodel.enums ?? []) as { name: string; values: { name: string }[] }[];
    const found = enums.find((e) => e.name === enumName);
    return found ? found.values.map((v) => v.name) : null;
}

/**
 * Get a model from the DMMF by name
 */
export function getModel(modelName: string): DMMFModel | undefined {
    if (!_dmmf) {
        throw new Error('DMMF not loaded. Call loadDMMF() first.');
    }
    if (_modelCache.has(modelName)) {
        return _modelCache.get(modelName);
    }
    const model = _dmmf.datamodel.models.find((m: DMMFModel) => m.name === modelName);
    _modelCache.set(modelName, model);
    return model;
}

/**
 * Get all fields for a model (including relation fields)
 */
export function getFields(modelName: string): Record<string, DMMFField> {
    const cached = _fieldsCache.get(modelName);
    if (cached) return cached;

    const model = getModel(modelName);
    if (!model) return {};
    const fields = model.fields.reduce((acc: Record<string, DMMFField>, field: DMMFField) => {
        acc[field.name] = field;
        return acc;
    }, {});
    _fieldsCache.set(modelName, fields);
    return fields;
}

/**
 * Get only scalar fields for a model (excludes relation fields)
 */
export function getScalarFields(modelName: string): Record<string, DMMFField> {
    const cached = _scalarFieldsCache.get(modelName);
    if (cached) return cached;

    const model = getModel(modelName);
    if (!model) return {};
    const fields = model.fields
        .filter((field: DMMFField) => field.kind !== 'object')
        .reduce((acc: Record<string, DMMFField>, field: DMMFField) => {
            acc[field.name] = field;
            return acc;
        }, {});
    _scalarFieldsCache.set(modelName, fields);
    return fields;
}

/**
 * Get the primary key field(s) for a model
 */
export function getPrimaryKey(modelName: string): string | string[] {
    const cached = _primaryKeyCache.get(modelName);
    if (cached) return cached;

    const model = getModel(modelName);
    if (!model) return 'id';

    const key = keyOf(model);
    const pk = key.length === 1 ? key[0] : key;
    _primaryKeyCache.set(modelName, pk);
    return pk;
}

/**
 * The fields that identify a row of a model: its @id / @@id — or, without one, its first
 * unique of required fields: a @unique field, else a @@unique. Prisma requires every model to
 * have one (a table without is left out as @@ignore).
 */
export function keyOf(model: Pick<DMMFModel, 'fields' | 'primaryKey' | 'uniqueIndexes'>): string[] {
    if (model.primaryKey?.fields?.length) return [...model.primaryKey.fields];
    const id = model.fields.find((f: DMMFField) => f.isId);
    if (id) return [id.name];
    const required = (names: string[]) => names.every((n) => model.fields.find((f: DMMFField) => f.name === n)?.isRequired === true);
    const candidates = [
        ...model.fields.filter((f: DMMFField) => f.kind !== 'object' && f.isUnique).map((f: DMMFField) => [f.name]),
        ...(model.uniqueIndexes ?? []).map((index) => [...index.fields]),
    ];
    return candidates.find(required) ?? ['id'];
}

/**
 * The Prisma selector name of a compound @@id / @@unique (`email_companyId`, or the
 * schema's `name:` when the index declares one)
 */
export function compoundKeyName(modelName: string, fields: string[]): string {
    const model = getModel(modelName);
    const sameFields = (index?: { name?: string | null; fields: string[] } | null) =>
        !!index && index.fields.length === fields.length && fields.every((f) => index.fields.includes(f));
    const index = sameFields(model?.primaryKey) ? model!.primaryKey! : model?.uniqueIndexes?.find(sameFields);
    // The selector follows the index's own field order: @@unique([b, a]) is `b_a`
    return index ? (index.name || index.fields.join('_')) : fields.join('_');
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
 * A relation field as the write paths read it. The side that holds the foreign key names its
 * columns and the columns they reference; the other side (a list, or a to-one without the key)
 * has none — its rows are addressed by their own key.
 */
export function relationConfig(rel: DMMFField): RelationConfig {
    const config: RelationConfig = { name: rel.name, object: rel.type, isList: rel.isList };
    if (rel.relationName) config.relationName = rel.relationName;
    const from = rel.relationFromFields ?? [];
    if (from.length > 0) {
        config.field = from[0];
        config.foreignKey = rel.relationToFields?.[0];
        if (from.length > 1) {
            config.fields = [...from];
            config.foreignKeys = [...(rel.relationToFields ?? [])];
        }
    }
    return config;
}

/**
 * Build relationships configuration for a model (replaces relationships.json).
 * Memoized — callers must treat the returned configs as read-only schema data
 * (QueryBuilder's #ensureRelations only adds idempotent schema-derived enrichment).
 */
export function buildRelationships(modelName: string): RelationConfig[] {
    const cached = _relationshipsCache.get(modelName);
    if (cached) return cached;

    const relations = getRelations(modelName);

    const configs = relations.map((rel: DMMFField) => {
        const config = relationConfig(rel);
        const targetRelations = getRelations(rel.type);
        if (targetRelations.length > 0) {
            config.relation = targetRelations.map(relationConfig);
        }
        return config;
    });

    _relationshipsCache.set(modelName, configs);
    return configs;
}

const { getDMMF } = require('@prisma/internals');
const fs = require('fs');
const path = require('path');

let _dmmf = null;
let _dmmfPromise = null;

/**
 * Load and cache the full DMMF from the Prisma schema
 * Uses @prisma/internals which provides complete DMMF including:
 * - isId, isList, isRequired
 * - relationFromFields, relationToFields
 * - primaryKey (for composite keys)
 * @returns {Promise<Object>} The full DMMF object
 */
async function loadDMMF() {
    if (_dmmf) {
        return _dmmf;
    }

    if (_dmmfPromise) {
        return _dmmfPromise;
    }

    _dmmfPromise = (async () => {
        const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        _dmmf = await getDMMF({ datamodel: schema });
        return _dmmf;
    })();

    return _dmmfPromise;
}

/**
 * Get cached DMMF synchronously (must call loadDMMF first)
 * @returns {Object|null} The cached DMMF or null if not loaded
 */
function getDMMFSync() {
    return _dmmf;
}

/**
 * Get a model from the DMMF by name
 * @param {string} modelName - The model name
 * @returns {Object|undefined} The model object or undefined
 */
function getModel(modelName) {
    if (!_dmmf) {
        throw new Error('DMMF not loaded. Call loadDMMF() first.');
    }
    return _dmmf.datamodel.models.find(m => m.name === modelName);
}

/**
 * Get all fields for a model
 * @param {string} modelName - The model name
 * @returns {Object} Object with field names as keys
 */
function getFields(modelName) {
    const model = getModel(modelName);
    if (!model) return {};
    return model.fields.reduce((acc, field) => {
        acc[field.name] = field;
        return acc;
    }, {});
}

/**
 * Get the primary key field(s) for a model
 * @param {string} modelName - The model name
 * @returns {string|string[]} Primary key field name or array for composite keys
 */
function getPrimaryKey(modelName) {
    const model = getModel(modelName);
    if (!model) return 'id';

    // Check for composite primary key (@@id)
    if (model.primaryKey?.fields?.length > 0) {
        return model.primaryKey.fields.length === 1
            ? model.primaryKey.fields[0]
            : model.primaryKey.fields;
    }

    // Find single @id field
    const idField = model.fields.find(f => f.isId);
    return idField ? idField.name : 'id';
}

/**
 * Get all relation fields for a model
 * @param {string} modelName - The model name
 * @returns {Object[]} Array of relation field objects
 */
function getRelations(modelName) {
    const model = getModel(modelName);
    if (!model) return [];
    return model.fields.filter(f => f.kind === 'object');
}

/**
 * Check if a field is a list relation
 * @param {string} modelName - The model name
 * @param {string} fieldName - The field name
 * @returns {boolean}
 */
function isListRelation(modelName, fieldName) {
    const model = getModel(modelName);
    if (!model) return false;
    const field = model.fields.find(f => f.name === fieldName);
    return field?.isList === true;
}

/**
 * Get relationship info for a relation field
 * @param {string} modelName - The model name
 * @param {string} relationName - The relation field name
 * @returns {Object|null} Relationship info with fromFields, toFields, targetModel
 */
function getRelationInfo(modelName, relationName) {
    const model = getModel(modelName);
    if (!model) return null;

    const field = model.fields.find(f => f.name === relationName && f.kind === 'object');
    if (!field) return null;

    return {
        name: field.name,
        targetModel: field.type,
        isList: field.isList,
        fromFields: field.relationFromFields || [],
        toFields: field.relationToFields || [],
        onDelete: field.relationOnDelete
    };
}

/**
 * Build relationships configuration for a model (replaces relationships.json)
 * @param {string} modelName - The model name
 * @returns {Object[]} Array of relationship configurations
 */
function buildRelationships(modelName) {
    const relations = getRelations(modelName);

    return relations.map(rel => {
        const config = {
            name: rel.name,
            object: rel.type,
            isList: rel.isList
        };

        // For relations with FK on this model (e.g., jobs.company_profiles)
        if (rel.relationFromFields?.length > 0) {
            config.field = rel.relationFromFields[0];
            config.foreignKey = rel.relationToFields?.[0] || 'id';

            // For composite FKs
            if (rel.relationFromFields.length > 1) {
                config.fields = rel.relationFromFields;
                config.foreignKeys = rel.relationToFields;
            }
        }

        // Build nested relations for the target model
        const targetRelations = getRelations(rel.type);
        if (targetRelations.length > 0) {
            config.relation = targetRelations.map(nested => ({
                name: nested.name,
                object: nested.type,
                isList: nested.isList,
                field: nested.relationFromFields?.[0],
                foreignKey: nested.relationToFields?.[0] || 'id'
            }));
        }

        return config;
    });
}

module.exports = {
    loadDMMF,
    getDMMFSync,
    getModel,
    getFields,
    getPrimaryKey,
    getRelations,
    isListRelation,
    getRelationInfo,
    buildRelationships
};

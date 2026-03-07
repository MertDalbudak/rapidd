import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

/**
 * Convert model name to PascalCase class name
 */
function toClassName(modelName: string): string {
  return modelName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

const numericTypes = ['Int', 'Float', 'Decimal', 'BigInt'];

/**
 * Detect if the primary key field is numeric
 */
function isNumericId(modelInfo: ModelInfo): boolean {
  for (const field of Object.values(modelInfo.fields)) {
    if (field.isId && numericTypes.includes(field.type)) {
      return true;
    }
  }
  return false;
}

// ─── Junction table detection ────────────────────────────────────────

interface ParentRelation {
  fkField: string;
  parentModel: string;
}

interface JunctionInfo {
  isJunction: boolean;
  parentRelations: ParentRelation[];
}

/**
 * Detect if a model is a junction (n:m) table.
 * A junction table has a composite primary key (@@id) with exactly 2 fields,
 * where each field maps to a parent relation.
 * Models with 3+ composite key fields are skipped entirely (no routes generated).
 */
function detectJunctionTable(_modelName: string, modelInfo: ModelInfo): JunctionInfo {
  if (!modelInfo.compositeKey || modelInfo.compositeKey.length !== 2) {
    return { isJunction: false, parentRelations: [] };
  }

  // Map each composite key field to its parent relation
  const parentRelations: ParentRelation[] = [];
  for (const keyField of modelInfo.compositeKey) {
    const rel = modelInfo.relations.find(r =>
      r.relationFromFields && r.relationFromFields.includes(keyField)
    );
    if (rel) {
      parentRelations.push({
        fkField: keyField,
        parentModel: rel.type,
      });
    }
  }

  // Both composite key fields must map to parent relations
  return {
    isJunction: parentRelations.length === 2,
    parentRelations,
  };
}

/**
 * Normalise a word for prefix comparison (strip trailing plural 's'/'es').
 */
function singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes') || word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Derive sub-route name by stripping the common leading word(s)
 * between parent model name and junction table name.
 * Handles plural/singular differences (e.g. "messages" vs "message_attachments").
 */
function computeSubRouteName(parentName: string, junctionName: string): string {
  const parentWords = parentName.split('_');
  const junctionWords = junctionName.split('_');

  let commonCount = 0;
  for (let i = 0; i < Math.min(parentWords.length, junctionWords.length); i++) {
    if (singularize(parentWords[i]) === singularize(junctionWords[i])) {
      commonCount++;
    } else {
      break;
    }
  }

  if (commonCount > 0 && commonCount < junctionWords.length) {
    return junctionWords.slice(commonCount).join('_');
  }

  return junctionName;
}

export interface SubRouteInfo {
  junctionModelName: string;
  junctionModelInfo: ModelInfo;
  subRouteName: string;
  fkFieldToParent: string;
  otherFkField: string;
}

interface JunctionMap {
  junctionModels: Set<string>;
  parentSubRoutes: Map<string, SubRouteInfo[]>;
}

/**
 * Analyse all models and build the junction / parent-sub-route map.
 */
function buildJunctionMap(models: Record<string, ModelInfo>): JunctionMap {
  const junctionModels = new Set<string>();
  const parentSubRoutes = new Map<string, SubRouteInfo[]>();

  for (const [modelName, modelInfo] of Object.entries(models)) {
    const junction = detectJunctionTable(modelName, modelInfo);
    if (!junction.isJunction) continue;

    junctionModels.add(modelName);

    for (let i = 0; i < junction.parentRelations.length; i++) {
      const parentRel = junction.parentRelations[i];
      const otherRels = junction.parentRelations.filter((_, j) => j !== i);
      if (!models[parentRel.parentModel]) continue;

      if (!parentSubRoutes.has(parentRel.parentModel)) {
        parentSubRoutes.set(parentRel.parentModel, []);
      }
      parentSubRoutes.get(parentRel.parentModel)!.push({
        junctionModelName: modelName,
        junctionModelInfo: modelInfo,
        subRouteName: computeSubRouteName(parentRel.parentModel, modelName),
        fkFieldToParent: parentRel.fkField,
        otherFkField: otherRels[0].fkField,
      });
    }
  }

  // Remove sub-route entries where the parent is itself a junction table
  for (const parentModel of parentSubRoutes.keys()) {
    if (junctionModels.has(parentModel)) {
      parentSubRoutes.delete(parentModel);
    }
  }

  return { junctionModels, parentSubRoutes };
}

// ─── Route file generators ──────────────────────────────────────────

/**
 * Generate Fastify route for a standalone model (TypeScript)
 */
export function generateRouteFile(modelName: string, modelInfo: ModelInfo, importPathPrefix = '../../../src/models'): string {
  const className = toClassName(modelName);
  const numeric = isNumericId(modelInfo);
  const idType = numeric ? 'number' : 'string';
  const idCast = numeric ? 'Number(rawId)' : 'rawId';
  return `import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className}, QueryBuilder } from '${importPathPrefix}/${className}';

const ${modelName}Routes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        (request as any).${className} = new ${className}({ user: request.user });
    });

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const query = request.query as Record<string, string>;
            const { q = {}, include = '', sortBy = 'id', sortOrder = 'asc', fields = null } = query;
            const model = (request as any).${className} as ${className};
            const totalResults = query.totalResults === 'true';
            const pagination = process.env.PAGINATION_MODE === 'page'
                ? { page: Number(query.page || '1'), pageSize: Number(query.pageSize || '25') }
                : undefined;
            const results = await model.getMany(q, include, Number(query.limit || '25'), Number(query.offset || '0'), sortBy, sortOrder as 'asc' | 'desc', fields, pagination, totalResults);
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawId } = request.params as { id: string };
            const id: ${idType} = ${idCast};
            const { include = '', fields = null } = request.query as Record<string, string>;
            const model = (request as any).${className} as ${className};
            const response = await model.get(id, include, {}, fields);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.create(payload);
            return reply.code(201).send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.patch('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id: rawId } = request.params as { id: string };
        const id: ${idType} = ${idCast};
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.update(id, payload);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.delete('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawId } = request.params as { id: string };
            const id: ${idType} = ${idCast};
            const model = (request as any).${className} as ${className};
            await model.delete(id);
            return reply.sendResponse(200, 'object_deleted_successfully', { modelName: '${className}' });
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });
};

export default ${modelName}Routes;
`;
}

/**
 * Generate Fastify route for a parent model that has sub-routes (TypeScript)
 */
export function generateParentRouteFile(modelName: string, modelInfo: ModelInfo, subRoutes: SubRouteInfo[]): string {
  const className = toClassName(modelName);
  const numeric = isNumericId(modelInfo);
  const idType = numeric ? 'number' : 'string';
  const idCast = numeric ? 'Number(rawId)' : 'rawId';
  const importPath = '../../../../src/models';

  const subRouteImports = subRoutes.map(sr =>
    `import ${sr.subRouteName}Routes from './_${sr.subRouteName}';`
  ).join('\n');

  const subRouteRegistrations = subRoutes.map(sr =>
    `    fastify.register(${sr.subRouteName}Routes, { prefix: '/:id/${sr.subRouteName}' });`
  ).join('\n');

  return `import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className}, QueryBuilder } from '${importPath}/${className}';
${subRouteImports}

const ${modelName}Routes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        (request as any).${className} = new ${className}({ user: request.user });
    });

${subRouteRegistrations}

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const query = request.query as Record<string, string>;
            const { q = {}, include = '', sortBy = 'id', sortOrder = 'asc', fields = null } = query;
            const model = (request as any).${className} as ${className};
            const totalResults = query.totalResults === 'true';
            const pagination = process.env.PAGINATION_MODE === 'page'
                ? { page: Number(query.page || '1'), pageSize: Number(query.pageSize || '25') }
                : undefined;
            const results = await model.getMany(q, include, Number(query.limit || '25'), Number(query.offset || '0'), sortBy, sortOrder as 'asc' | 'desc', fields, pagination, totalResults);
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawId } = request.params as { id: string };
            const id: ${idType} = ${idCast};
            const { include = '', fields = null } = request.query as Record<string, string>;
            const model = (request as any).${className} as ${className};
            const response = await model.get(id, include, {}, fields);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.create(payload);
            return reply.code(201).send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.patch('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id: rawId } = request.params as { id: string };
        const id: ${idType} = ${idCast};
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.update(id, payload);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.delete('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawId } = request.params as { id: string };
            const id: ${idType} = ${idCast};
            const model = (request as any).${className} as ${className};
            await model.delete(id);
            return reply.sendResponse(200, 'object_deleted_successfully', { modelName: '${className}' });
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });
};

export default ${modelName}Routes;
`;
}

/**
 * Check if a specific field in a model is numeric
 */
function isFieldNumeric(modelInfo: ModelInfo, fieldName: string): boolean {
  const field = modelInfo.fields[fieldName];
  return !!field && numericTypes.includes(field.type);
}

/**
 * Generate Fastify sub-route for a junction table (TypeScript).
 * Uses composite key { fkFieldToParent: parentId, otherFkField: subId }
 * for get, update, and delete operations.
 */
export function generateSubRouteFile(
  junctionModelName: string,
  junctionModelInfo: ModelInfo,
  parentModelInfo: ModelInfo,
  fkFieldToParent: string,
  otherFkField: string,
): string {
  const className = toClassName(junctionModelName);
  const numericParentId = isNumericId(parentModelInfo);
  const numericOtherFk = isFieldNumeric(junctionModelInfo, otherFkField);
  const parentIdType = numericParentId ? 'number' : 'string';
  const otherFkType = numericOtherFk ? 'number' : 'string';
  const parentIdCast = numericParentId ? 'Number(rawParentId)' : 'rawParentId';
  const otherFkCast = numericOtherFk ? 'Number(rawSubId)' : 'rawSubId';
  const importPath = '../../../../src/models';

  return `import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className}, QueryBuilder } from '${importPath}/${className}';

const ${junctionModelName}Routes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        (request as any).${className} = new ${className}({ user: request.user });
    });

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawParentId } = request.params as { id: string };
            const parentId: ${parentIdType} = ${parentIdCast};
            const query = request.query as Record<string, string>;
            const { q = {}, include = '', sortBy = 'id', sortOrder = 'asc', fields = null } = query;
            const filter = typeof q === 'object' ? { ...q, ${fkFieldToParent}: parentId } : { ${fkFieldToParent}: parentId };
            const model = (request as any).${className} as ${className};
            const totalResults = query.totalResults === 'true';
            const pagination = process.env.PAGINATION_MODE === 'page'
                ? { page: Number(query.page || '1'), pageSize: Number(query.pageSize || '25') }
                : undefined;
            const results = await model.getMany(filter, include, Number(query.limit || '25'), Number(query.offset || '0'), sortBy, sortOrder as 'asc' | 'desc', fields, pagination, totalResults);
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.get('/:subId', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawParentId, subId: rawSubId } = request.params as { id: string; subId: string };
            const parentId: ${parentIdType} = ${parentIdCast};
            const ${otherFkField}: ${otherFkType} = ${otherFkCast};
            const compositeId = { ${fkFieldToParent}: parentId, ${otherFkField} };
            const { include = '', fields = null } = request.query as Record<string, string>;
            const model = (request as any).${className} as ${className};
            const response = await model.get(compositeId, include, {}, fields);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id: rawParentId } = request.params as { id: string };
        const parentId: ${parentIdType} = ${parentIdCast};
        const payload = { ...(request.body as Record<string, unknown>), ${fkFieldToParent}: parentId };
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.create(payload);
            return reply.code(201).send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.patch('/:subId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id: rawParentId, subId: rawSubId } = request.params as { id: string; subId: string };
        const parentId: ${parentIdType} = ${parentIdCast};
        const ${otherFkField}: ${otherFkType} = ${otherFkCast};
        const compositeId = { ${fkFieldToParent}: parentId, ${otherFkField} };
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.update(compositeId, payload);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.delete('/:subId', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawParentId, subId: rawSubId } = request.params as { id: string; subId: string };
            const parentId: ${parentIdType} = ${parentIdCast};
            const ${otherFkField}: ${otherFkType} = ${otherFkCast};
            const compositeId = { ${fkFieldToParent}: parentId, ${otherFkField} };
            const model = (request as any).${className} as ${className};
            await model.delete(compositeId);
            return reply.sendResponse(200, 'object_deleted_successfully', { modelName: '${className}' });
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });
};

export default ${junctionModelName}Routes;
`;
}

// ─── Main generation orchestrator ───────────────────────────────────

/**
 * Generate all route files with junction-table-aware nested structure.
 * @param models      Models to generate routes for (may be filtered by --model)
 * @param routesDir   Output directory (e.g. routes/api/v1)
 * @param allModels   Full models map for junction detection (defaults to models)
 */
export function generateAllRoutes(
  models: Record<string, ModelInfo>,
  routesDir: string,
  allModels?: Record<string, ModelInfo>,
): void {
  if (!fs.existsSync(routesDir)) {
    fs.mkdirSync(routesDir, { recursive: true });
  }

  const { junctionModels, parentSubRoutes } = buildJunctionMap(allModels ?? models);

  for (const [modelName, modelInfo] of Object.entries(models)) {
    // Skip models with 3+ composite key fields – no clean RESTful representation
    if (modelInfo.compositeKey && modelInfo.compositeKey.length > 2) {
      console.log(`Skipped route (3+ composite key): ${modelName}`);
      continue;
    }

    // Skip junction tables – they become sub-routes, not standalone files
    if (junctionModels.has(modelName)) {
      console.log(`Skipped route (junction table): ${modelName}`);
      continue;
    }

    const subRoutes = parentSubRoutes.get(modelName);

    if (subRoutes && subRoutes.length > 0) {
      // ── Parent model with sub-routes → directory structure ──
      const parentDir = path.join(routesDir, modelName);
      const indexPath = path.join(parentDir, 'index.ts');

      // If a legacy flat file exists, skip entirely (never overwrite)
      const legacyFlatPath = path.join(routesDir, `${modelName}.ts`);
      if (fs.existsSync(legacyFlatPath)) {
        console.log(`Skipped route (legacy flat file exists): ${modelName}.ts`);
        continue;
      }

      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Generate parent index.ts
      if (fs.existsSync(indexPath)) {
        console.log(`Skipped route (exists): ${modelName}/index.ts`);
      } else {
        const parentCode = generateParentRouteFile(modelName, modelInfo, subRoutes);
        fs.writeFileSync(indexPath, parentCode);
        console.log(`Generated route: ${modelName}/index.ts`);
      }

      // Generate each sub-route file
      for (const sr of subRoutes) {
        const subRoutePath = path.join(parentDir, `_${sr.subRouteName}.ts`);
        if (fs.existsSync(subRoutePath)) {
          console.log(`Skipped sub-route (exists): ${modelName}/_${sr.subRouteName}.ts`);
          continue;
        }
        const subRouteCode = generateSubRouteFile(
          sr.junctionModelName,
          sr.junctionModelInfo,
          modelInfo,
          sr.fkFieldToParent,
          sr.otherFkField,
        );
        fs.writeFileSync(subRoutePath, subRouteCode);
        console.log(`Generated sub-route: ${modelName}/_${sr.subRouteName}.ts`);
      }
    } else {
      // ── Standalone model → flat file (unchanged behaviour) ──
      const routePath = path.join(routesDir, `${modelName}.ts`);
      if (fs.existsSync(routePath)) {
        console.log(`Skipped route (exists): ${modelName}.ts`);
        continue;
      }
      const routeCode = generateRouteFile(modelName, modelInfo);
      fs.writeFileSync(routePath, routeCode);
      console.log(`Generated route: ${modelName}.ts`);
    }
  }
}

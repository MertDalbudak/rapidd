import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildSections, currentValues, plainValues, validate, saveSettings, exportSettings, generateSecret, mask, drivers, secretKeys } from './settings';
import type { ExportFormat } from './settings';
import { matches } from './catalog';
import type { CheckName, Values } from './catalog';
import { runCheck, CHECK_NAMES } from './checks';
import { inspectProject, alignSchemaProvider, readSchema, forgetConfigModules } from './project';
import { runAction, actionBlocker, buildSupport } from './actions';
import type { ActionName, BuildOptions } from './actions';
import { adminStatus, createFirstUser } from './admin';
import { envFilePath } from './envfile';
import { CONFIG_FILES, isConfigFileId, readConfigText, validateConfigFile, writeConfigFiles } from './files';
import type { ConfigFileId } from './files';
import { modelsOverview, aclContext, routePrefixes } from './models';
import { rlsStatus, rlsStatements, applyRls, RlsSpecError } from './rls';
import { renameRelations, renameInRules, jsonTextColumns, typeJsonColumns, writeSchema, SchemaEditError } from './schema';
import { proxyView } from './proxy';
import type { ProxyView } from './proxy';
import type { Renames } from './schema';
import type { RlsOperation } from './rls';
import { testService } from './services';
import { setupReasons } from './index';
import type { SetupReason, WizardLaunch } from './index';
import { wizardPage, passwordPage } from './ui';
import { LOGO_PNG } from './ui/logo';
import { resetAppConfig } from '../core/config';
import { Logger } from '../utils/Logger';

/**
 * The setup wizard over HTTP — served on first boot while the API cannot start; finishing it
 * hands over to the API in the same process. Access needs the setup password printed to the
 * console (or SETUP_PASSWORD): /setup?password=… exchanges it for an HttpOnly session cookie;
 * API calls also need the X-Rapidd-Setup header (no cross-site request can set it), or
 * `Authorization: Bearer <password>` for scripted installs.
 */

export interface WizardOptions {
    /** Why the API cannot start (printed with the link) */
    reasons?: SetupReason[];
    /**
     * How it was opened: `auto` — the API cannot start; `on` — SETUP_WIZARD=on; `setup` —
     * `npm run setup`: finishing ends the wizard without starting the API, and is possible
     * while the API still cannot start
     */
    mode?: WizardLaunch;
    host?: string;
    port?: number;
    /** The setup password (default: SETUP_PASSWORD, else random per start) */
    password?: string;
    root?: string;
    /** Called with the URL to open (default: printed to the console) */
    announce?: (url: string, password: string) => void;
}

export interface WizardHandle {
    app: FastifyInstance;
    url: string;
    password: string;
    /** Resolves when the wizard is finished and its server closed */
    done: Promise<void>;
}

const COOKIE = 'rapidd_setup';
const ACTIONS: ActionName[] = ['generate', 'pull', 'push', 'migrate', 'build'];
type StagedFiles = Partial<Record<ConfigFileId, string>>;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return undefined;
}

export async function startWizardServer(options: WizardOptions): Promise<WizardHandle> {
    const root = options.root ?? process.cwd();
    const password = options.password ?? process.env.SETUP_PASSWORD ?? crypto.randomBytes(24).toString('base64url');
    const sessions = new Set<string>();
    const failures = new Map<string, { count: number; until: number }>();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    // Secrets suggested for this run: fresh, so a click-through setup is secure
    const suggested: Record<string, string> = {};
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET']) {
        if (!process.env[key]) suggested[key] = generateSecret();
    }
    // TRUST_PROXY behind Cloudflare: suggested once per run while unset — cleared, it stays cleared
    let proxySuggested = false;

    const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('X-Frame-Options', 'DENY');
        return payload;
    });

    const locked = (ip: string) => (failures.get(ip)?.until ?? 0) > Date.now();
    const fail = (ip: string) => {
        const entry = failures.get(ip) ?? { count: 0, until: 0 };
        entry.count++;
        if (entry.count >= MAX_FAILURES) entry.until = Date.now() + LOCKOUT_MS;
        failures.set(ip, entry);
    };

    const authenticated = (request: FastifyRequest): boolean => {
        const session = cookieValue(request, COOKIE);
        if (session && sessions.has(session)) return true;
        const auth = request.headers.authorization;
        return !!auth?.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), password);
    };

    const page = (reply: FastifyReply, html: (nonce: string) => string, status = 200) => {
        const nonce = crypto.randomBytes(16).toString('base64');
        reply.header('Content-Security-Policy',
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
        return reply.code(status).type('text/html; charset=utf-8').send(html(nonce));
    };

    // ── Health: alive, but not ready — orchestrators keep the instance, load balancers skip it
    app.get('/health', async () => ({ status: 'setup' }));
    app.get('/health/ready', async (_request, reply) => reply.code(503).send({ status: 'setup_required' }));
    app.get('/', async (_request, reply) => reply.redirect('/setup'));
    // Public: the sign-in page shows it too
    app.get('/setup/assets/logo.png', async (_request, reply) => reply.type('image/png').header('Cache-Control', 'public, max-age=86400').send(LOGO_PNG));

    app.get('/setup', async (request, reply) => {
        const query = request.query as { password?: string };
        if (query.password !== undefined) {
            if (locked(request.ip)) return page(reply, (n) => passwordPage(n, 'Too many wrong passwords — try again in 15 minutes.'), 429);
            if (!safeEqual(String(query.password), password)) {
                fail(request.ip);
                return page(reply, (n) => passwordPage(n, 'That password is not valid.'), 401);
            }
            failures.delete(request.ip);
            const session = crypto.randomBytes(32).toString('base64url');
            sessions.add(session);
            const secure = request.protocol === 'https' ? '; Secure' : '';
            reply.header('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/setup${secure}`);
            return reply.redirect('/setup'); // drops the password from the address bar and history
        }
        if (!authenticated(request)) return page(reply, (n) => passwordPage(n));
        return page(reply, (n) => wizardPage(n));
    });

    // ── API ───────────────────────────────────────────────────────────────────
    app.register(async (api) => {
        api.addHook('onRequest', async (request, reply) => {
            if (locked(request.ip)) return reply.code(429).send({ error: 'locked' });
            const viaCookie = !!cookieValue(request, COOKIE) && sessions.has(cookieValue(request, COOKIE)!);
            if (!authenticated(request)) {
                if (request.headers.authorization) fail(request.ip);
                return reply.code(401).send({ error: 'Setup password required' });
            }
            // Cookie sessions must prove the request came from the wizard page itself
            if (viaCookie && request.headers['x-rapidd-setup'] !== '1') {
                return reply.code(403).send({ error: 'Missing X-Rapidd-Setup header' });
            }
        });

        /** Staged config files of a request: known ids, text only */
        const filesOf = (request: FastifyRequest): StagedFiles => {
            const files = (request.body as any)?.files;
            const out: StagedFiles = {};
            if (files && typeof files === 'object') {
                for (const [id, text] of Object.entries(files)) if (isConfigFileId(id) && typeof text === 'string') out[id] = text;
            }
            return out;
        };
        const context = async (files: StagedFiles = {}) => {
            const project = await inspectProject(root, plainValues(currentValues(buildSections())), { app: files.app });
            return { project, sections: buildSections(project) };
        };
        /** Current values with the client's changes applied (keys set by the real environment stay) */
        const merged = (sections: ReturnType<typeof buildSections>, changes: Values = {}): Values => {
            const current = currentValues(sections);
            const values = plainValues(current);
            for (const [key, value] of Object.entries(changes ?? {})) {
                if (typeof value !== 'string' && value !== null && value !== undefined) continue;
                if (current[key]?.locked) continue;
                values[key] = value ?? '';
            }
            return values;
        };
        const changesOf = (request: FastifyRequest): Values => ((request.body as any)?.changes ?? {}) as Values;
        /** Field names per model — rules files are checked against them */
        const schemaFields = async (): Promise<Record<string, string[]> | undefined> => {
            const { dmmf } = await readSchema(root);
            return dmmf ? Object.fromEntries(dmmf.datamodel.models.map((m) => [m.name, m.fields.map((f) => f.name)])) : undefined;
        };
        const fileProblems = async (files: StagedFiles): Promise<Partial<Record<ConfigFileId, string[]>>> => {
            const fields = await schemaFields();
            const problems: Partial<Record<ConfigFileId, string[]>> = {};
            for (const [id, text] of Object.entries(files) as [ConfigFileId, string][]) {
                const found = validateConfigFile(id, text, fields);
                if (found.length) problems[id] = found;
            }
            return problems;
        };
        const appName = (() => {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
                return { name: String(pkg.name ?? path.basename(root)), version: pkg.version ? String(pkg.version) : null };
            } catch {
                return { name: path.basename(root), version: null };
            }
        })();

        api.get('/state', async (request) => {
            const { project, sections } = await context();
            const current = currentValues(sections);
            const secrets = secretKeys(sections);
            let proxy = await proxyOf(request, merged(sections, suggested));
            if (!proxySuggested && proxy.proposal && current.TRUST_PROXY && current.TRUST_PROXY.value === '' && !current.TRUST_PROXY.locked) {
                suggested.TRUST_PROXY = proxy.proposal;
                proxySuggested = true;
                proxy = await proxyOf(request, merged(sections, suggested));
            }
            const values = merged(sections, suggested);
            return {
                app: appName,
                mode: options.mode ?? 'auto',
                reasons: await setupReasons(root),
                envFile: project.envFile,
                container: project.container,
                sections: sections.map((s) => ({ ...s, visible: matches(s.when, values) })),
                values: Object.fromEntries(Object.entries(current).map(([key, v]) => [key, {
                    value: secrets.has(key) ? mask(v.value) : v.value,
                    hasValue: v.value !== '',
                    source: v.source,
                    locked: v.locked,
                }])),
                suggested,
                drivers: drivers(sections),
                validation: withProxy(validate(values, sections, project), proxy),
                proxy,
                files: Object.fromEntries((Object.keys(CONFIG_FILES) as ConfigFileId[]).map((id) => [id, readConfigText(root, id)])),
                project,
            };
        });

        // A saved secret, on request (the state only carries masked values)
        api.post('/reveal', async (request, reply) => {
            const key = String((request.body as any)?.key ?? '');
            const { sections } = await context(filesOf(request));
            if (!sections.some((s) => s.settings.some((x) => x.key === key))) return reply.code(404).send({ error: 'Unknown setting' });
            return { key, value: process.env[key] ?? '' };
        });

        api.post('/evaluate', async (request) => {
            const files = filesOf(request);
            const { project, sections } = await context(files);
            const values = merged(sections, changesOf(request));
            const proxy = await proxyOf(request, values);
            return {
                validation: withProxy(validate(values, sections, project), proxy),
                proxy,
                fileProblems: await fileProblems(files),
                // With a staged config/app.json the ${ENV} references — and so the sections — may differ
                sections: files.app !== undefined
                    ? sections.map((s) => ({ ...s, visible: matches(s.when, values) }))
                    : sections.map((s) => ({ id: s.id, visible: matches(s.when, values) })),
            };
        });

        /** How this page's request came in, and the client IP the API makes of it with TRUST_PROXY */
        async function proxyOf(request: FastifyRequest, values: Values): Promise<ProxyView> {
            return proxyView({ peer: request.raw.socket.remoteAddress ?? request.ip, headers: request.headers }, values);
        }

        /** Behind Cloudflare without trusting it: said under TRUST_PROXY and on the review */
        function withProxy<V extends { errors: Record<string, string>; warnings: Record<string, string> }>(validation: V, proxy: ProxyView): V {
            if (proxy.message && !validation.errors.TRUST_PROXY) validation.warnings.TRUST_PROXY = proxy.message;
            return validation;
        }

        api.post('/check/:name', async (request, reply) => {
            const name = (request.params as { name: string }).name as CheckName;
            if (!CHECK_NAMES.includes(name)) return reply.code(404).send({ error: 'Unknown check' });
            const { sections } = await context();
            const body = (request.body ?? {}) as { username?: string; password?: string };
            return runCheck(name, merged(sections, changesOf(request)), { username: body.username, password: body.password });
        });

        /** The schema, generated code per model, and what the actions can do */
        api.post('/project', async (request) => {
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const project = await inspectProject(root, values);
            const { dmmf } = await readSchema(root);
            const models = modelsOverview(root, dmmf);
            const actions: Record<string, string | null> = {};
            for (const name of ACTIONS) actions[name] = await actionBlocker(name, values, root);
            return { project, actions, models, build: await buildSupport(root), routes: routePrefixes(models) };
        });

        api.post('/action/:name', async (request, reply) => {
            const name = (request.params as { name: string }).name as ActionName;
            if (!ACTIONS.includes(name)) return reply.code(404).send({ error: 'Unknown action' });
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const body = ((request.body as any)?.build ?? {}) as BuildOptions;
            const build: BuildOptions = {
                models: Array.isArray(body.models) ? body.models.filter((m) => typeof m === 'string') : undefined,
                components: Array.isArray(body.components) ? body.components.filter((c) => c === 'model' || c === 'route') : undefined,
            };
            const result = await runAction(name, values, root, build);
            forgetConfigModules();
            Logger.log(`Setup: ${result.message}`);
            return result;
        });

        /** The schema rewritten, then the Prisma client generated for it */
        const schemaChange = async (request: FastifyRequest, change: (source: string, dmmf: NonNullable<Awaited<ReturnType<typeof readSchema>>['dmmf']>) => Promise<string> | string) => {
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const { dmmf } = await readSchema(root);
            if (!dmmf) return { error: 'Fix the errors in prisma/schema.prisma first' };
            try {
                const source = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
                await writeSchema(root, await change(source, dmmf));
            } catch (err) {
                if (err instanceof SchemaEditError) return { error: err.message };
                throw err;
            }
            const generated = await runAction('generate', values, root);
            forgetConfigModules();
            return { dmmf, generated };
        };

        /** Relation fields renamed — introspection names them after models; the staged access rules follow */
        api.post('/schema/relations', async (request, reply) => {
            const body = (request.body ?? {}) as { renames?: unknown; acl?: unknown };
            const renames = body.renames as Renames;
            const valid = !!renames && typeof renames === 'object' && Object.values(renames).every((map) =>
                !!map && typeof map === 'object' && Object.values(map).every((name) => typeof name === 'string'));
            if (!valid) return reply.code(400).send({ error: 'renames: { "<model>": { "<relation>": "<new name>" } }' });
            const count = Object.values(renames).reduce((n, map) => n + Object.entries(map).filter(([from, to]) => from !== to).length, 0);
            const result = await schemaChange(request, (source, dmmf) => renameRelations(source, dmmf, renames));
            if ('error' in result) return reply.code(400).send(result);
            Logger.log(`Setup: ${count} relation field(s) renamed in prisma/schema.prisma`);
            const what = `${count} relation${count === 1 ? '' : 's'} renamed`;
            return {
                ok: result.generated.ok,
                message: result.generated.ok ? `${what} — Prisma client generated` : `${what}; ${result.generated.message}`,
                output: result.generated.output,
                ...(body.acl && typeof body.acl === 'object' ? { acl: renameInRules(body.acl, result.dmmf, renames) } : {}),
            };
        });

        /** JSON columns MariaDB stores as LONGTEXT and the schema types as String: listed, or typed Json (apply) */
        api.post('/schema/json', async (request, reply) => {
            const apply = (request.body as { apply?: unknown } | undefined)?.apply === true;
            const { sections } = await context();
            const url = merged(sections, changesOf(request)).DATABASE_URL;
            const { dmmf } = await readSchema(root);
            if (!dmmf || !url) return { fields: [] };
            let columns;
            try {
                columns = await jsonTextColumns(url);
            } catch (err) {
                return { fields: [], error: `Cannot read the database: ${(err as Error).message}` };
            }
            const source = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
            const { fields } = typeJsonColumns(source, dmmf, columns);
            if (!apply || fields.length === 0) return { fields };
            const result = await schemaChange(request, (current, latest) => typeJsonColumns(current, latest, columns).source);
            if ('error' in result) return reply.code(400).send(result);
            Logger.log(`Setup: typed Json in prisma/schema.prisma — ${fields.join(', ')}`);
            return {
                fields,
                ok: result.generated.ok,
                message: result.generated.ok ? `${fields.length} JSON column${fields.length === 1 ? '' : 's'} typed Json — Prisma client generated` : result.generated.message,
                output: result.generated.output,
            };
        });

        /** What the access rule editor needs: models, fields, code-owned models, roles, user attributes */
        api.post('/acl/context', async (request) => {
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const { dmmf } = await readSchema(root);
            const roleField = String((request.body as any)?.roleField || 'role');
            return aclContext(root, dmmf, values, roleField);
        });

        /** Row-level security as the database enforces it */
        api.post('/rls', async (request) => {
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const project = await inspectProject(root, values);
            const { dmmf } = await readSchema(root);
            return { ...(await rlsStatus(values, modelsOverview(root, dmmf), project.userModel?.model ?? null)), variablesSource: project.rls.source };
        });

        /** The SQL of a row-level security change — preview (apply: false) or run it */
        const rlsChange = async (request: FastifyRequest, reply: FastifyReply, apply: boolean) => {
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const { dmmf } = await readSchema(root);
            const operation = (request.body as any)?.operation as RlsOperation;
            let statements: string[];
            try {
                if (!operation || typeof operation !== 'object') throw new RlsSpecError('Which change?');
                statements = rlsStatements(operation, modelsOverview(root, dmmf), values);
            } catch (err) {
                if (!(err instanceof RlsSpecError)) throw err;
                return reply.code(400).send({ error: err.message });
            }
            if (!apply) return { statements };
            const result = await applyRls(statements, values);
            if (result.ok) Logger.log(`Setup: row-level security — ${statements.map((x) => x.split('\n')[0]).join(' · ')}`);
            return { ...result, statements };
        };
        api.post('/rls/sql', (request, reply) => rlsChange(request, reply, false));
        api.post('/rls/apply', (request, reply) => rlsChange(request, reply, true));

        /** A test call of a service endpoint, with the unsaved configuration */
        api.post('/services/test', async (request) => {
            const body = (request.body ?? {}) as { service?: string; endpoint?: string; params?: Record<string, unknown> };
            const files = filesOf(request);
            const { sections } = await context(files);
            const values = merged(sections, changesOf(request));
            const params = Object.fromEntries(Object.entries(body.params ?? {}).map(([k, v]) => [k, String(v ?? '')]));
            const text = files.app ?? readConfigText(root, 'app') ?? '{}';
            return testService(text, String(body.service ?? ''), String(body.endpoint ?? ''), params, values);
        });

        api.post('/admin/status', async (request) => {
            const { sections } = await context();
            return adminStatus(merged(sections, changesOf(request)), root);
        });

        api.post('/admin', async (request) => {
            const { sections } = await context();
            const user = ((request.body as any)?.user ?? {}) as Record<string, unknown>;
            const result = await createFirstUser(merged(sections, changesOf(request)), user, root);
            if (result.ok) Logger.log(`Setup: ${result.message}`);
            return result;
        });

        api.post('/export', async (request, reply) => {
            const format = ((request.body as any)?.format ?? 'env') as ExportFormat;
            if (!['env', 'compose', 'kubernetes', 'shell'].includes(format)) return reply.code(400).send({ error: 'Unknown format' });
            const { sections } = await context(filesOf(request));
            const values = merged(sections, changesOf(request));
            const keys = new Set(sections.flatMap((s) => s.settings.map((x) => x.key)));
            return { text: exportSettings(Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k))), format, sections) };
        });

        /** Write the env changes and the staged config files — everything validated first */
        const save = async (request: FastifyRequest, reply: FastifyReply) => {
            const files = filesOf(request);
            const { project, sections } = await context(files);
            const changes = changesOf(request);
            const values = merged(sections, changes);
            const validation = validate(values, sections, project);
            // Generated secrets of settings that do not apply (token secrets without sign-in) are not written
            for (const [key, value] of Object.entries(changes)) {
                if (suggested[key] !== undefined && value === suggested[key] && !validation.visible.includes(key)) delete changes[key];
            }
            const invalid = Object.keys(changes).filter((k) => validation.errors[k]);
            const problems = await fileProblems(files);
            if (invalid.length > 0 || Object.keys(problems).length > 0) {
                reply.code(400);
                return { error: invalid.length ? 'Some values are invalid' : 'Some files are invalid', validation, fileProblems: problems };
            }
            try {
                const result = saveSettings(changes, sections, envFilePath());
                for (const key of Object.keys(changes)) delete suggested[key];
                if (result.written.length + result.removed.length > 0) {
                    Logger.log(`Setup: saved ${result.written.length + result.removed.length} setting(s) to ${result.file}`);
                }
                const written = writeConfigFiles(root, files);
                if (written.length > 0) Logger.log(`Setup: wrote ${written.join(', ')}`);
                // The API must read what was just written — not modules or config loaded before
                forgetConfigModules();
                resetAppConfig();
                // A fresh schema follows the database it now points to (the scaffold says postgresql)
                const schema = 'DATABASE_URL' in changes ? alignSchemaProvider(root, process.env.DATABASE_URL) : { changed: false };
                if (schema.changed) Logger.log(`Setup: prisma/schema.prisma datasource provider set to ${schema.to}`);
                const after = await context();
                return {
                    saved: result,
                    files: written,
                    texts: Object.fromEntries((Object.keys(CONFIG_FILES) as ConfigFileId[]).map((id) => [id, readConfigText(root, id)])),
                    schema,
                    validation: validate(merged(after.sections), after.sections, after.project),
                };
            } catch (err: any) {
                reply.code(500);
                return { error: err?.code === 'EACCES' || err?.code === 'EROFS'
                    ? `Cannot write ${err?.path ?? envFilePath()} (${err.code}) — set ENV_FILE to a writable path, or copy the export into your environment`
                    : `Saving failed: ${err?.message || err}` };
            }
        };

        api.post('/save', save);

        api.post('/finish', async (request, reply) => {
            // Never start with throwaway secrets: generated ones still unset are saved too
            const body = (request.body ?? {}) as { changes?: Values; files?: StagedFiles };
            body.changes = { ...Object.fromEntries(Object.entries(suggested).filter(([k]) => !process.env[k])), ...(body.changes ?? {}) };
            (request as any).body = body;
            if (Object.keys(changesOf(request)).length > 0 || Object.keys(filesOf(request)).length > 0) {
                const saved = await save(request, reply);
                if (reply.statusCode >= 400) return saved;
            }
            const reasons = await setupReasons(root);
            // npm run setup ends here either way — the API is started separately
            const command = options.mode === 'setup';
            if (reasons.length > 0 && !command) {
                return reply.code(409).send({ error: 'The API still cannot start', reasons });
            }
            forgetConfigModules();
            const port = Number(process.env.PORT || 3000);
            reply.send(command ? { ok: true, exit: true, reasons } : { ok: true, port });
            // Hand over after the response is out
            setImmediate(finish);
            return reply;
        });
    }, { prefix: '/setup/api' });

    const host = options.host ?? process.env.HOST ?? '0.0.0.0';
    const port = options.port ?? Number(process.env.PORT || 3000);
    try {
        await app.listen({ host, port });
    } catch (err: any) {
        if (err?.code !== 'EADDRINUSE') throw err;
        throw new Error(options.mode === 'setup'
            ? `Port ${port} is in use — is the API running? Stop it, or run the setup on another port: PORT=${port + 1} npm run setup`
            : `Port ${port} is in use`);
    }
    const address = app.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    const url = `http://${shownHost}:${actualPort}/setup`;

    const done = finished.then(async () => {
        await app.close();
    });
    return { app, url, password, done };
}

/** Serve the wizard and wait until it is finished */
export async function runWebWizard(options: WizardOptions): Promise<void> {
    const handle = await startWizardServer(options);
    const announce = options.announce ?? ((url: string, password: string) => {
        const headline = options.mode === 'setup'
            ? `  Rapidd setup — the wizard is running${options.reasons?.length ? '; the API cannot start yet:' : '.'}`
            : options.reasons?.length || options.mode !== 'on'
                ? '  Rapidd is not configured yet — the setup wizard is running.'
                : '  SETUP_WIZARD=on — the setup wizard is running; the API starts when you finish it.';
        const lines = [
            '',
            headline,
            ...(options.reasons ?? []).map((r) => `    · ${r.key}: ${r.message}`),
            '',
            `  Open:  ${url}?password=${encodeURIComponent(password)}`,
            '',
        ];
        // Printed, not logged: the password must not end up in log files or aggregators
        process.stdout.write(lines.join('\n') + '\n');
    });
    announce(handle.url, handle.password);
    await handle.done;
}

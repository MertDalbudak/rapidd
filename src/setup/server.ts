import crypto from 'crypto';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildSections, currentValues, plainValues, validate, saveSettings, exportSettings, generateSecret, mask, drivers, secretKeys } from './settings';
import type { ExportFormat } from './settings';
import { matches } from './catalog';
import type { CheckName, Values } from './catalog';
import { runCheck, CHECK_NAMES } from './checks';
import { inspectProject, readConfigFile } from './project';
import { runAction, actionBlocker } from './actions';
import type { ActionName } from './actions';
import { adminStatus, createFirstUser } from './admin';
import { envFilePath, writeEnvFile } from './envfile';
import { setupReasons } from './index';
import type { SetupReason } from './index';
import { wizardPage, passwordPage } from './ui';
import { Logger } from '../utils/Logger';
import path from 'path';
import fs from 'fs';

/**
 * The setup wizard over HTTP. Access needs the setup password printed to the console
 * (or SETUP_PASSWORD): /setup?password=… exchanges it for an HttpOnly session cookie; API calls
 * also need the X-Rapidd-Setup header (no cross-site request can set it), or
 * `Authorization: Bearer <password>` for scripted installs.
 */

export interface WizardOptions {
    /** first-boot: finishing hands over to the API in this process · explicit: finishing ends the wizard */
    mode: 'first-boot' | 'explicit';
    reasons?: SetupReason[];
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
const FILES: Record<string, string> = { app: 'config/app.json', rateLimit: 'config/rate-limit.json' };
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
    // Secrets suggested for this run (first boot): fresh, so a click-through setup is secure
    const suggested: Record<string, string> = {};
    if (options.mode === 'first-boot') {
        for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET']) {
            if (!process.env[key]) suggested[key] = generateSecret();
        }
    }

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

        const context = async () => {
            const project = await inspectProject(root, plainValues(currentValues(buildSections())));
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

        api.get('/state', async () => {
            const { project, sections } = await context();
            const current = currentValues(sections);
            const secrets = secretKeys(sections);
            const values = merged(sections, suggested);
            return {
                mode: options.mode,
                reasons: options.mode === 'first-boot' ? await setupReasons(root) : [],
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
                validation: validate(values, sections, project),
                project,
            };
        });

        // A saved secret, on request (the state only carries masked values)
        api.post('/reveal', async (request, reply) => {
            const key = String((request.body as any)?.key ?? '');
            const { sections } = await context();
            if (!sections.some((s) => s.settings.some((x) => x.key === key))) return reply.code(404).send({ error: 'Unknown setting' });
            return { key, value: process.env[key] ?? '' };
        });

        api.post('/evaluate', async (request) => {
            const { project, sections } = await context();
            const values = merged(sections, changesOf(request));
            return { validation: validate(values, sections, project), sections: sections.map((s) => ({ id: s.id, visible: matches(s.when, values) })) };
        });

        api.post('/check/:name', async (request, reply) => {
            const name = (request.params as { name: string }).name as CheckName;
            if (!CHECK_NAMES.includes(name)) return reply.code(404).send({ error: 'Unknown check' });
            const { sections } = await context();
            const body = (request.body ?? {}) as { username?: string; password?: string };
            return runCheck(name, merged(sections, changesOf(request)), { username: body.username, password: body.password });
        });

        api.post('/project', async (request) => {
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const project = await inspectProject(root, values);
            const actions: Record<string, string | null> = {};
            for (const name of ACTIONS) actions[name] = await actionBlocker(name, values, root);
            return { project, actions };
        });

        api.post('/action/:name', async (request, reply) => {
            const name = (request.params as { name: string }).name as ActionName;
            if (!ACTIONS.includes(name)) return reply.code(404).send({ error: 'Unknown action' });
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const result = await runAction(name, values, root);
            Logger.log(`Setup: ${result.message}`);
            return result;
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

        api.get('/file/:id', async (request, reply) => {
            const rel = FILES[(request.params as { id: string }).id];
            if (!rel) return reply.code(404).send({ error: 'Unknown file' });
            return readConfigFile(root, rel);
        });

        api.put('/file/:id', async (request, reply) => {
            const rel = FILES[(request.params as { id: string }).id];
            if (!rel) return reply.code(404).send({ error: 'Unknown file' });
            const content = String((request.body as any)?.content ?? '');
            try {
                const parsed = JSON.parse(content);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
            } catch (err) {
                return reply.code(400).send({ error: `Invalid JSON: ${(err as Error).message}` });
            }
            const file = path.join(root, rel);
            writeEnvFile(file, content.endsWith('\n') ? content : `${content}\n`);
            fs.chmodSync(file, 0o644); // a config file, not a secret store
            Logger.log(`Setup: wrote ${rel}`);
            return readConfigFile(root, rel);
        });

        api.post('/export', async (request, reply) => {
            const format = ((request.body as any)?.format ?? 'env') as ExportFormat;
            if (!['env', 'compose', 'kubernetes', 'shell'].includes(format)) return reply.code(400).send({ error: 'Unknown format' });
            const { sections } = await context();
            const values = merged(sections, changesOf(request));
            const keys = new Set(sections.flatMap((s) => s.settings.map((x) => x.key)));
            return { text: exportSettings(Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k))), format, sections) };
        });

        const save = async (request: FastifyRequest, reply: FastifyReply) => {
            const { project, sections } = await context();
            const changes = changesOf(request);
            const values = merged(sections, changes);
            const validation = validate(values, sections, project);
            const invalid = Object.keys(changes).filter((k) => validation.errors[k]);
            if (invalid.length > 0) {
                reply.code(400);
                return { error: 'Some values are invalid', validation };
            }
            try {
                const result = saveSettings(changes, sections, envFilePath());
                for (const key of Object.keys(changes)) delete suggested[key];
                Logger.log(`Setup: saved ${result.written.length + result.removed.length} setting(s) to ${result.file}`);
                return { saved: result, validation: validate(merged(sections), sections, project) };
            } catch (err: any) {
                reply.code(500);
                return { error: err?.code === 'EACCES' || err?.code === 'EROFS'
                    ? `Cannot write ${envFilePath()} (${err.code}) — set ENV_FILE to a writable path, or copy the export into your environment`
                    : `Saving failed: ${err?.message || err}` };
            }
        };

        api.post('/save', save);

        api.post('/finish', async (request, reply) => {
            // Never start with throwaway secrets: generated ones still unset are saved too
            const body = (request.body ?? {}) as { changes?: Values };
            body.changes = { ...Object.fromEntries(Object.entries(suggested).filter(([k]) => !process.env[k])), ...(body.changes ?? {}) };
            (request as any).body = body;
            if (Object.keys(changesOf(request)).length > 0) {
                const saved = await save(request, reply);
                if (reply.statusCode >= 400) return saved;
            }
            const reasons = options.mode === 'first-boot' ? await setupReasons(root) : [];
            if (reasons.length > 0) {
                return reply.code(409).send({ error: 'The API still cannot start', reasons });
            }
            const port = Number(process.env.PORT || 3000);
            reply.send({ ok: true, mode: options.mode, port });
            // Hand over after the response is out
            setImmediate(finish);
            return reply;
        });
    }, { prefix: '/setup/api' });

    const host = options.host ?? process.env.HOST ?? '0.0.0.0';
    const port = options.port ?? Number(process.env.PORT || 3000);
    await app.listen({ host, port });
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
        const lines = [
            '',
            options.mode === 'first-boot' ? '  Rapidd is not configured yet — the setup wizard is running.' : '  Rapidd setup wizard',
            ...(options.reasons ?? []).map((r) => `    · ${r.key}: ${r.message}`),
            '',
            `  Open:  ${url}?password=${encodeURIComponent(password)}`,
            '  (or run `npm run setup` in a terminal)',
            '',
        ];
        // Printed, not logged: the password must not end up in log files or aggregators
        process.stdout.write(lines.join('\n') + '\n');
    });
    announce(handle.url, handle.password);
    await handle.done;
}

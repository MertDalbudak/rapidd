import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { findBin, inspectProject, alignSchemaProvider, cliDatabaseUrl, readSchema } from './project';
import { detectProvider } from '../core/adapter';
import { databaseInfo } from './checks';
import { jsonTextColumns, typeJsonColumns, writeSchema } from './schema';
import type { Values } from './catalog';

/**
 * Project actions the wizard can run — each one guarded so a first-boot screen can never
 * damage an existing database or schema:
 *
 * - generate  prisma generate                      always safe
 * - pull      prisma db pull                       only while the schema has no models; MariaDB's JSON
 *                                                  columns are typed Json afterwards
 * - push      prisma db push                       only while the database has none of the schema's tables
 * - migrate   prisma migrate deploy                only when prisma/migrations exists
 * - build     rapidd build (models, routes)        never overwrites existing files
 */

export type ActionName = 'generate' | 'pull' | 'push' | 'migrate' | 'build';

/** What `build` generates: model classes and/or REST routes, for all or some models */
export interface BuildOptions {
    models?: string[];
    components?: ('model' | 'route' | 'acl')[];
}

export interface BuildSupport {
    installed: boolean;
    /** --model takes a comma-separated list (else one model per run) */
    modelList: boolean;
    /** --skip-generate (else every run regenerates the Prisma client) */
    skipGenerate: boolean;
}

export interface ActionResult {
    ok: boolean;
    message: string;
    output: string;
}

const MAX_OUTPUT = 64 * 1024;

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const collect = (chunk: Buffer) => {
            output += chunk.toString();
            if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            output += `\nStopped after ${timeoutMs / 1000} s`;
        }, timeoutMs);
        child.on('close', (code) => {
            clearTimeout(timer);
            // eslint-disable-next-line no-control-regex
            resolve({ code, output: output.replace(/\u001b\[[0-9;]*m/g, '') });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: 1, output: `${output}\n${err.message}` });
        });
    });
}

let _support: { key: string; support: BuildSupport } | null = null;

/** The options of the installed @rapidd/build — read from its help, once per installed version */
export async function buildSupport(root: string = process.cwd()): Promise<BuildSupport> {
    const bin = findBin('@rapidd/build', root);
    if (!bin) return { installed: false, modelList: false, skipGenerate: false };
    let key = bin;
    try {
        key = `${bin}:${fs.statSync(bin).mtimeMs}`;
    } catch {
        // keyed by path only
    }
    if (_support?.key === key) return _support.support;
    const { output } = await run(bin, ['build', '--help'], root, { ...process.env, FORCE_COLOR: '0' }, 15_000);
    const support = { installed: true, modelList: /--model <names>/.test(output), skipGenerate: output.includes('--skip-generate') };
    _support = { key, support };
    return support;
}

/** Why an action is not available right now, or null when it is */
export async function actionBlocker(name: ActionName, values: Values, root: string = process.cwd()): Promise<string | null> {
    const project = await inspectProject(root, values);
    if (name === 'build' && !project.tools.rapiddBuild) return '@rapidd/build is not installed (npm install -D @rapidd/build)';
    if (!project.tools.prisma) return 'The prisma CLI is not installed here (it is a dev dependency)';
    if (!project.schema.exists) return 'prisma/schema.prisma does not exist';
    // prisma.config.ts reads DATABASE_URL with env(), which fails when it is unset — for every command
    if (!values.DATABASE_URL) return 'Set the database connection first';
    if (name === 'build') {
        if (project.schema.error) return 'Fix the errors in prisma/schema.prisma first';
        return project.schema.models.length > 0 ? null : 'The schema has no models yet — read them from the database, or write them';
    }
    // A schema with models for another database cannot be used (a fresh one is switched over)
    if (project.schema.models.length > 0 && project.schema.provider && project.schema.provider !== detectProvider(values.DATABASE_URL)) {
        return `prisma/schema.prisma is for ${project.schema.provider}, the database is ${detectProvider(values.DATABASE_URL)} — change the datasource provider in the schema`;
    }
    if (name === 'generate') return null;
    if (name === 'pull') {
        return project.schema.models.length === 0 ? null : 'The schema already has models — pulling would replace them';
    }
    if (name === 'migrate') {
        return project.migrations ? null : 'There is no prisma/migrations folder';
    }
    // push: create-only — refuse as soon as any of the schema's tables exist
    if (project.schema.models.length === 0) return 'The schema has no models to create';
    let tables: string[];
    try {
        // Seen as the push runs: the admin connection, when set (MySQL lists only the tables a user may use)
        tables = (await databaseInfo(values.DATABASE_URL_ADMIN || values.DATABASE_URL)).tables;
    } catch (err) {
        return `Cannot reach the database: ${(err as Error).message}`;
    }
    const existing = Object.values(project.schema.tables).filter((t) => tables.includes(t));
    if (existing.length > 0) {
        return `The database already has ${existing.length} of the schema's tables — use migrations (prisma migrate) to change it`;
    }
    return null;
}

/**
 * The rapidd build runs for these options: one per component and — for an older @rapidd/build —
 * per model. Always with --only, so only the chosen components are written (acl: src/config/acl.ts
 * while it has no entries — the generator never changes one that has).
 */
export function buildRuns(options: BuildOptions, allModels: string[], support: BuildSupport): string[][] {
    const components = options.components?.length ? options.components : (['model', 'route'] as const);
    const selected = (options.models ?? []).filter((m) => allModels.includes(m));
    const everything = selected.length === 0 || allModels.every((m) => selected.includes(m));
    const modelArgs = everything ? [undefined] : support.modelList ? [selected.join(',')] : selected;
    const runs: string[][] = [];
    for (const component of components) {
        for (const model of modelArgs) {
            const args = ['build'];
            if (model) args.push('--model', model);
            args.push('--only', component);
            // The client is generated by the first run — the others only need code
            if (runs.length > 0 && support.skipGenerate) args.push('--skip-generate');
            runs.push(args);
        }
    }
    return runs;
}

/** The environment of a command run for the project: the settings over the process's own */
function commandEnv(values: Values): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== '') env[key] = value;
    }
    if (env.DATABASE_URL) env.DATABASE_URL = cliDatabaseUrl(env.DATABASE_URL);
    env.FORCE_COLOR = '0';
    // Prisma refuses some commands from non-interactive shells without this
    env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
    return env;
}

/** A prisma CLI command for the project, with the given settings */
export async function runPrisma(args: string[], values: Values, root: string = process.cwd(), timeoutMs = 120_000): Promise<{ code: number | null; output: string }> {
    const prisma = findBin('prisma', root);
    if (!prisma) return { code: 1, output: 'The prisma CLI is not installed here (it is a dev dependency)' };
    return run(prisma, args, root, commandEnv(values), timeoutMs);
}

/** Run a project action with the given settings (DATABASE_URL & co. need not be saved yet) */
export async function runAction(name: ActionName, values: Values, root: string = process.cwd(), options: BuildOptions = {}): Promise<ActionResult> {
    const blocker = await actionBlocker(name, values, root);
    if (blocker) return { ok: false, message: blocker, output: '' };

    // A fresh schema follows the database (the scaffold says postgresql)
    const aligned: { changed: boolean; from?: string; to?: string } = name === 'build' ? { changed: false } : alignSchemaProvider(root, values.DATABASE_URL);

    const env = commandEnv(values);

    if (name === 'build') {
        const project = await inspectProject(root, values);
        const bin = findBin('@rapidd/build', root)!;
        const runs = buildRuns(options, project.schema.models, await buildSupport(root));
        let output = '';
        for (const args of runs) {
            const result = await run(bin, args, root, env, 300_000);
            output += `$ rapidd ${args.join(' ')}\n${result.output.trim()}\n\n`;
            if (result.code !== 0) return { ok: false, message: `rapidd build failed (exit ${result.code})`, output: output.trim() };
        }
        return { ok: true, message: 'rapidd build finished', output: output.trim() };
    }

    // Changing the schema takes its owner — the admin connection, when the API's role isn't it
    if ((name === 'push' || name === 'migrate') && values.DATABASE_URL_ADMIN) {
        env.DATABASE_URL = cliDatabaseUrl(values.DATABASE_URL_ADMIN);
    }

    const prisma = findBin('prisma', root)!;
    const commands: Record<Exclude<ActionName, 'build'>, () => [string[], number]> = {
        generate: () => [['generate'], 120_000],
        pull: () => [['db', 'pull'], 120_000],
        push: () => [['db', 'push'], 300_000],
        migrate: () => [['migrate', 'deploy'], 300_000],
    };
    const [args, timeout] = commands[name]();
    const { code, output } = await run(prisma, args, root, env, timeout);
    const label = `prisma ${args.join(' ')}`;
    const note = aligned.changed ? `prisma/schema.prisma: datasource provider set to ${aligned.to} (was ${aligned.from}) to match the database\n\n` : '';
    const json = name === 'pull' && code === 0 && values.DATABASE_URL ? await typeJsonAfterPull(root, values.DATABASE_URL) : '';
    return { ok: code === 0, message: code === 0 ? `${label} finished` : `${label} failed (exit ${code})`, output: (note + output).trim() + json };
}

/** After a pull: JSON columns MariaDB stores as LONGTEXT typed Json — a note for the output */
async function typeJsonAfterPull(root: string, url: string): Promise<string> {
    if (detectProvider(url) !== 'mysql') return '';
    try {
        const { dmmf } = await readSchema(root);
        if (!dmmf) return '';
        const source = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
        const { source: typed, fields } = typeJsonColumns(source, dmmf, await jsonTextColumns(url));
        if (!fields.length) return '';
        await writeSchema(root, typed);
        return `\n\nprisma/schema.prisma: typed Json — ${fields.join(', ')} (MariaDB stores JSON as LONGTEXT, which Prisma reads as String)`;
    } catch (err) {
        return `\n\nJSON columns were not typed: ${(err as Error).message}`;
    }
}

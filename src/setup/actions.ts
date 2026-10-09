import { spawn } from 'child_process';
import { findBin, inspectProject } from './project';
import { databaseInfo } from './checks';
import type { Values } from './catalog';

/**
 * Project actions the wizard can run — each one guarded so a first-boot screen can never
 * damage an existing database or schema:
 *
 * - generate  prisma generate                      always safe
 * - pull      prisma db pull                       only while the schema has no models
 * - push      prisma db push                       only while the database has none of the schema's tables
 * - migrate   prisma migrate deploy                only when prisma/migrations exists
 * - build     rapidd build (models, routes, ACL)   never overwrites existing files
 */

export type ActionName = 'generate' | 'pull' | 'push' | 'migrate' | 'build';

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

/** Why an action is not available right now, or null when it is */
export async function actionBlocker(name: ActionName, values: Values, root: string = process.cwd()): Promise<string | null> {
    const project = await inspectProject(root, values);
    if (name === 'build') {
        return project.tools.rapiddBuild ? null : '@rapidd/build is not installed (npm install -D @rapidd/build)';
    }
    if (!project.tools.prisma) return 'The prisma CLI is not installed here (it is a dev dependency)';
    if (!project.schema.exists) return 'prisma/schema.prisma does not exist';
    // prisma.config.ts reads DATABASE_URL with env(), which fails when it is unset — for every command
    if (!values.DATABASE_URL) return 'Set the database connection first';
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
        tables = (await databaseInfo(values.DATABASE_URL)).tables;
    } catch (err) {
        return `Cannot reach the database: ${(err as Error).message}`;
    }
    const existing = Object.values(project.schema.tables).filter((t) => tables.includes(t));
    if (existing.length > 0) {
        return `The database already has ${existing.length} of the schema's tables — use migrations (prisma migrate) to change it`;
    }
    return null;
}

/** Run a project action with the given settings (DATABASE_URL & co. need not be saved yet) */
export async function runAction(name: ActionName, values: Values, root: string = process.cwd()): Promise<ActionResult> {
    const blocker = await actionBlocker(name, values, root);
    if (blocker) return { ok: false, message: blocker, output: '' };

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== '') env[key] = value;
    }
    env.FORCE_COLOR = '0';
    // Prisma refuses some commands from non-interactive shells without this
    env.PRISMA_HIDE_UPDATE_MESSAGE = '1';

    const prisma = findBin('prisma', root)!;
    const commands: Record<ActionName, () => [string, string[], number]> = {
        generate: () => [prisma, ['generate'], 120_000],
        pull: () => [prisma, ['db', 'pull'], 120_000],
        push: () => [prisma, ['db', 'push'], 300_000],
        migrate: () => [prisma, ['migrate', 'deploy'], 300_000],
        build: () => [findBin('@rapidd/build', root)!, ['build'], 300_000],
    };
    const [bin, args, timeout] = commands[name]();
    const { code, output } = await run(bin, args, root, env, timeout);
    const label = name === 'build' ? 'rapidd build' : `prisma ${args.join(' ')}`;
    return { ok: code === 0, message: code === 0 ? `${label} finished` : `${label} failed (exit ${code})`, output: output.trim() };
}

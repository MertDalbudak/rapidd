import fs from 'fs';
import path from 'path';
import { SECTIONS } from './catalog';
import { validate, plainValues, currentValues } from './settings';
import { inspectProject } from './project';
import { Logger } from '../utils/Logger';

/**
 * Setup entry points used by main.ts:
 * - firstBoot(): while the API cannot start, serve the setup wizard; returns once configured
 * - runSetupCommand(): `npm run setup` — the same setup in the terminal (or --web)
 */

export interface SetupReason {
    key: string;
    message: string;
}

/**
 * Why the API cannot start with the current configuration — empty when it can. Limited to
 * problems that already stop it today, so a running deployment never lands in setup.
 */
export async function setupReasons(root: string = process.cwd()): Promise<SetupReason[]> {
    const values = plainValues(currentValues(SECTIONS));
    const schemaFile = path.join(root, 'prisma', 'schema.prisma');
    let provider: string | null = null;
    try {
        provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(fs.readFileSync(schemaFile, 'utf8'))?.[1] ?? null;
    } catch {
        provider = null;
    }
    let validation = validate(values, SECTIONS, { schema: { provider } as any });
    // JWT secrets only matter when auth is on — that needs the schema (is there a user table?)
    if (validation.blockers.some((k) => k.startsWith('JWT_'))) {
        validation = validate(values, SECTIONS, await inspectProject(root, values));
    }
    const reasons = validation.blockers.map((key) => ({ key, message: validation.errors[key] }));

    let clientReady = true;
    try {
        require.resolve(path.join(root, 'prisma', 'client'));
    } catch {
        clientReady = false;
    }
    if (!clientReady) reasons.push({ key: 'prisma/client', message: 'The Prisma client has not been generated' });
    return reasons;
}

/** SETUP_WIZARD: auto (default) — serve the wizard while the API cannot start; off — fail as before */
export function wizardEnabled(): boolean {
    return (process.env.SETUP_WIZARD || 'auto').toLowerCase() !== 'off';
}

/**
 * First boot: when the API cannot start, serve the setup wizard (HTTP) until the
 * configuration is complete, then return — main.ts goes on to start the API in the same
 * process. Returns immediately when nothing is missing or SETUP_WIZARD=off.
 */
export async function firstBoot(): Promise<void> {
    const reasons = await setupReasons();
    if (reasons.length === 0 || !wizardEnabled()) return;
    const { runWebWizard } = await import('./server');
    await runWebWizard({ mode: 'first-boot', reasons });
    Logger.configure();
}

/** `npm run setup [-- options]` — see `npm run setup -- --help`. Returns the exit code. */
export async function runSetupCommand(argv: string[]): Promise<number> {
    const { runCli } = await import('./cli');
    return runCli(argv);
}

export { buildSections, validate, saveSettings, exportSettings } from './settings';
export { runCheck } from './checks';
export { inspectProject } from './project';
export { SECTIONS } from './catalog';

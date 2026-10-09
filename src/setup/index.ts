import fs from 'fs';
import path from 'path';
import { SECTIONS } from './catalog';
import { validate, plainValues, currentValues } from './settings';
import { inspectProject, clientProvider } from './project';
import { Logger } from '../utils/Logger';
import { ACL_RULES_FILE, loadAclRules } from '../core/aclRules';
import { RLS_RULES_FILE, loadRlsRules } from '../core/rlsRules';

/**
 * Setup entry point used by main.ts — firstBoot(): while the API cannot start, serve the setup
 * wizard; returns once it is configured.
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
    else if (provider && clientProvider(root) && clientProvider(root) !== provider) {
        reasons.push({ key: 'prisma/client', message: `The Prisma client was generated for ${clientProvider(root)} — generate it again for ${provider}` });
    }

    // Rules files the API refuses to start with (they never fail open)
    for (const [file, load] of [[ACL_RULES_FILE, loadAclRules], [RLS_RULES_FILE, loadRlsRules]] as const) {
        try {
            load(path.join(root, file));
        } catch (err) {
            reasons.push({ key: file, message: (err as Error).message.replace(path.join(root, file), file) });
        }
    }
    return reasons;
}

export type WizardMode = 'auto' | 'on' | 'off';

/**
 * SETUP_WIZARD: auto (default) — serve the wizard while the API cannot start; on — at every
 * start, before the API (to change the access rules, services, ...); off — never
 */
export function wizardMode(): WizardMode {
    const mode = (process.env.SETUP_WIZARD || 'auto').toLowerCase();
    return mode === 'on' || mode === 'off' ? mode : 'auto';
}

/**
 * Boot: when the API cannot start (or SETUP_WIZARD=on), serve the setup wizard (HTTP) until
 * it is finished, then return — main.ts goes on to start the API in the same process.
 * Returns immediately when nothing is missing, or with SETUP_WIZARD=off.
 */
export async function firstBoot(): Promise<void> {
    const mode = wizardMode();
    if (mode === 'off') return;
    const reasons = await setupReasons();
    if (reasons.length === 0 && mode !== 'on') return;
    const { runWebWizard } = await import('./server');
    await runWebWizard({ reasons, mode });
    Logger.configure();
}

import path from 'path';
import bcrypt from 'bcrypt';
import { createAdapter } from '../core/adapter';
import { parseScalar } from '../orm/values';
import { readSchema, describeUserModel, userModelCandidates } from './project';
import type { UserModelInfo } from './project';
import { listItems } from './catalog';
import type { Values } from './catalog';

/**
 * The first user account. Offered only while the user table is empty — on a running
 * system, accounts are managed through the API, never through a setup screen.
 */

/** A standalone Prisma client for the given settings (not the app's — that one doesn't exist yet) */
function openClient(values: Values, root: string): { client: any; close: () => Promise<void> } {
    const clientDir = path.join(root, 'prisma', 'client');
    // The wizard may have regenerated the client since it was first loaded
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(clientDir)) delete require.cache[key];
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require(clientDir);
    const { adapter, pool } = createAdapter(values.DATABASE_URL || '', values.DATABASE_PROVIDER || null);
    const client = new PrismaClient({ adapter });
    return {
        client,
        close: async () => {
            await client.$disconnect().catch(() => undefined);
            await (pool as { end?: () => Promise<void> } | null)?.end?.().catch(() => undefined);
        },
    };
}

export interface AdminStatus {
    available: boolean;
    reason?: string;
    /** Tables that look like users, when none is detected */
    candidates?: string[];
    model?: UserModelInfo;
    users?: number;
}

/** Can a first user be created — and which fields does it need? */
export async function adminStatus(values: Values, root: string = process.cwd()): Promise<AdminStatus> {
    if (listItems(values.AUTH_PROVIDERS).includes('none')) return { available: false, reason: 'Sign-in is off (AUTH_PROVIDERS=none) — the API needs no accounts' };
    const schema = await readSchema(root);
    if (!schema.dmmf) return { available: false, reason: schema.exists ? 'The Prisma schema cannot be read' : 'There is no Prisma schema yet' };
    const model = describeUserModel(schema.dmmf, values);
    if (!model) {
        const candidates = userModelCandidates(schema.dmmf);
        return { available: false, reason: `No user table detected (user, users, account, accounts — or set DB_USER_TABLE)${candidates.length ? ` — ${candidates.join(' or ')} looks like one` : ''}`, candidates };
    }
    if (!model.passwordField) return { available: false, reason: `${model.model} has no password column`, model };
    if (!values.DATABASE_URL) return { available: false, reason: 'Set the database connection first', model };

    let db;
    try {
        db = openClient(values, root);
    } catch (err) {
        return { available: false, reason: `The Prisma client is not ready (${(err as Error).message.split('\n')[0]}) — generate it first`, model };
    }
    try {
        const users = await db.client[model.model].count();
        return users === 0
            ? { available: true, model, users }
            : { available: false, reason: `${model.model} already has ${users} account(s)`, model, users };
    } catch (err) {
        return { available: false, reason: `Cannot read ${model.model}: ${(err as Error).message.split('\n').pop()}`, model };
    } finally {
        await db.close();
    }
}

/** Create the first user. `input` holds the field values and `password`. */
export async function createFirstUser(
    values: Values,
    input: Record<string, unknown>,
    root: string = process.cwd()
): Promise<{ ok: boolean; message: string; errors?: Record<string, string>; user?: Record<string, unknown> }> {
    const status = await adminStatus(values, root);
    if (!status.available || !status.model) return { ok: false, message: status.reason || 'Not available' };
    const { model, passwordField, fields } = status.model;

    const errors: Record<string, string> = {};
    const data: Record<string, unknown> = {};
    for (const field of fields) {
        const raw = input[field.name];
        if (raw === undefined || raw === null || raw === '') {
            if (field.required) errors[field.name] = 'Required';
            continue;
        }
        const parsed = parseScalar({ name: field.name, type: field.type, kind: field.kind } as any, raw);
        if (parsed === undefined || (field.enumValues && !field.enumValues.includes(String(parsed)))) {
            errors[field.name] = field.enumValues ? `One of: ${field.enumValues.join(', ')}` : `Not a valid ${field.type}`;
            continue;
        }
        data[field.name] = parsed;
    }
    const password = typeof input.password === 'string' ? input.password : '';
    if (password.length < 8) errors.password = 'At least 8 characters';
    if (Object.keys(errors).length > 0) return { ok: false, message: 'Check the highlighted fields', errors };

    const rounds = parseInt(values.AUTH_SALT_ROUNDS || '10', 10) || 10;
    data[passwordField!] = await bcrypt.hash(password, rounds);

    const db = openClient(values, root);
    try {
        // Re-check inside the same connection: never a second "first" user
        if (await db.client[model].count() > 0) return { ok: false, message: `${model} is no longer empty` };
        const created = await db.client[model].create({ data });
        const { [passwordField!]: _hash, ...user } = created;
        return { ok: true, message: `Created the first ${model} account`, user };
    } catch (err: any) {
        return { ok: false, message: err?.code === 'P2002' ? 'That value is already taken' : (err?.message ?? String(err)).split('\n').pop() };
    } finally {
        await db.close();
    }
}

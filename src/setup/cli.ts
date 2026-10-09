import readline from 'readline';
import { buildSections, currentValues, plainValues, validate, saveSettings, exportSettings, generateSecret, mask, secretKeys } from './settings';
import type { ExportFormat } from './settings';
import { matches, listItems } from './catalog';
import type { Section, Setting, Values, CheckName } from './catalog';
import { runCheck } from './checks';
import type { CheckResult } from './checks';
import { inspectProject } from './project';
import type { ProjectInfo } from './project';
import { runAction, actionBlocker } from './actions';
import { adminStatus, createFirstUser } from './admin';
import { envFilePath, reloadEnvFile } from './envfile';
import { setupReasons } from './index';

/**
 * `npm run setup` — the setup wizard in the terminal, and scriptable commands for CI and
 * automated installs. Same catalog, validation and checks as the HTTP wizard.
 */

const USAGE = `Usage: npm run setup [-- options]

  (no options)              Interactive setup: every setting, connection tests, schema & code, first user
  --section <id>            Interactive, one section only (e.g. database, auth, redis)
  --advanced                Also ask for advanced settings
  --web                     The same wizard in the browser (--host, --port; default 127.0.0.1)
  --show                    Print every setting, its value and where it comes from (--all: also unused ones)
  --check [name ...]        Connection tests: database, redis, ldap, oidc, webdav (default: all that apply)
  --set KEY=VALUE           Change a setting (repeatable)
  --unset KEY               Remove a setting from the env file (repeatable)
  --generate-secrets        Fill unset JWT_SECRET, JWT_REFRESH_SECRET and COOKIE_SECRET
  --export <format>         Print the configuration as env, compose, kubernetes or shell (contains secrets)
  --env-file <path>         Use this env file instead of ENV_FILE / .env
  --yes, -y                 Do not ask for confirmation
  --show-secrets            Print secret values in --show

Exit code 1 when a check fails or a value is invalid.`;

export interface CliIO {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    /** Interactive terminal (hidden password input, colors). Default: input.isTTY */
    tty?: boolean;
}

interface Args {
    help: boolean; web: boolean; show: boolean; all: boolean; advanced: boolean; yes: boolean; showSecrets: boolean; generateSecrets: boolean;
    check: string[] | null; set: [string, string][]; unset: string[]; section: string | null; export: string | null;
    envFile: string | null; host: string | null; port: number | null; unknown: string[];
}

function parseArgs(argv: string[]): Args {
    const a: Args = { help: false, web: false, show: false, all: false, advanced: false, yes: false, showSecrets: false, generateSecrets: false,
        check: null, set: [], unset: [], section: null, export: null, envFile: null, host: null, port: null, unknown: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '-h': case '--help': a.help = true; break;
            case '--web': a.web = true; break;
            case '--show': a.show = true; break;
            case '--all': a.all = true; break;
            case '--advanced': a.advanced = true; break;
            case '-y': case '--yes': a.yes = true; break;
            case '--show-secrets': a.showSecrets = true; break;
            case '--generate-secrets': a.generateSecrets = true; break;
            case '--check':
                a.check = [];
                while (argv[i + 1] && !argv[i + 1].startsWith('-')) a.check.push(next());
                break;
            case '--set': {
                const pair = next() ?? '';
                const eq = pair.indexOf('=');
                if (eq < 1) a.unknown.push(`--set ${pair}`);
                else a.set.push([pair.slice(0, eq), pair.slice(eq + 1)]);
                break;
            }
            case '--unset': a.unset.push(next() ?? ''); break;
            case '--section': a.section = next() ?? null; break;
            case '--export': a.export = next() ?? 'env'; break;
            case '--env-file': a.envFile = next() ?? null; break;
            case '--host': a.host = next() ?? null; break;
            case '--port': a.port = Number(next()); break;
            default: a.unknown.push(arg);
        }
    }
    return a;
}

// ── Terminal ──────────────────────────────────────────────────────────────────

class Terminal {
    private lines: string[] = [];
    private waiting: ((line: string | null) => void) | null = null;
    private closed = false;
    private muted = false;
    private rl: readline.Interface;
    readonly color: boolean;

    constructor(private io: CliIO) {
        const tty = io.tty ?? !!(io.input as any).isTTY;
        this.color = tty && !process.env.NO_COLOR;
        this.rl = readline.createInterface({ input: io.input, output: io.output, terminal: tty });
        // Hidden input: swallow the echo while muted
        const rlAny = this.rl as any;
        const write = rlAny._writeToOutput?.bind(this.rl);
        if (write) rlAny._writeToOutput = (s: string) => { if (!this.muted) write(s); };
        this.rl.on('line', (line) => {
            if (this.waiting) { const w = this.waiting; this.waiting = null; w(line); } else this.lines.push(line);
        });
        this.rl.on('SIGINT', () => {
            this.print('\nStopped — nothing written.');
            process.exit(130);
        });
        this.rl.on('close', () => {
            this.closed = true;
            if (this.waiting) { const w = this.waiting; this.waiting = null; w(null); }
        });
    }

    print(text = ''): void { this.io.output.write(text + '\n'); }
    style(code: string, text: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
    bold(t: string) { return this.style('1', t); }
    dim(t: string) { return this.style('2', t); }
    green(t: string) { return this.style('32', t); }
    red(t: string) { return this.style('31', t); }
    yellow(t: string) { return this.style('33', t); }

    /** Ask for one line; null at end of input */
    async ask(prompt: string, hidden = false): Promise<string | null> {
        this.io.output.write(prompt);
        if (this.lines.length) {
            const line = this.lines.shift()!;
            if (hidden || !this.color) this.io.output.write('\n');
            return line;
        }
        if (this.closed) { this.io.output.write('\n'); return null; }
        this.muted = hidden && this.color;
        const line = await new Promise<string | null>((resolve) => { this.waiting = resolve; });
        if (this.muted) this.io.output.write('\n');
        this.muted = false;
        return line;
    }

    async confirm(question: string, yes = true): Promise<boolean> {
        const answer = await this.ask(`${question} ${yes ? '[Y/n]' : '[y/N]'} `);
        if (answer === null || answer.trim() === '') return yes;
        return /^y(es)?$/i.test(answer.trim());
    }

    close(): void { this.rl.close(); }
}

// ── Output helpers ────────────────────────────────────────────────────────────

function printResult(t: Terminal, name: string, r: CheckResult): void {
    t.print(`  ${r.ok ? t.green('✓') : t.red('✗')} ${t.bold(name)} — ${r.message}`);
    for (const s of r.steps ?? []) t.print(`      ${s.ok ? t.green('✓') : t.red('✗')} ${s.target}: ${s.message}`);
    for (const [k, v] of Object.entries(r.details ?? {})) {
        const text = Array.isArray(v) ? `${v.length}${v.length ? `: ${v.slice(0, 20).join(', ')}${v.length > 20 ? ', …' : ''}` : ''}`
            : v && typeof v === 'object' ? JSON.stringify(v) : String(v);
        t.print(t.dim(`      ${k.replace(/_/g, ' ')}: ${text}`));
    }
}

function display(value: string, secret: boolean, showSecrets = false): string {
    if (!value) return '';
    return secret && !showSecrets ? mask(value) : value;
}

/** Checks that apply to these values: database always, the others when configured/enabled */
function applicableChecks(values: Values): CheckName[] {
    const names: CheckName[] = ['database'];
    if (values.REDIS_URL || values.REDIS_HOST) names.push('redis');
    for (const p of ['ldap', 'oidc', 'webdav'] as CheckName[]) if (listItems(values.AUTH_PROVIDERS).includes(p)) names.push(p);
    return names;
}

// ── Commands ──────────────────────────────────────────────────────────────────

function show(t: Terminal, sections: Section[], project: ProjectInfo, args: Args): number {
    const current = currentValues(sections);
    const values = plainValues(current);
    const validation = validate(values, sections, project);
    t.print(t.bold(`Env file: ${envFilePath()}`) + (project.envFile.exists ? '' : t.dim(' (does not exist yet)')));
    let group = '';
    for (const section of sections) {
        const visible = matches(section.when, values);
        const settings = section.settings.filter((s) => args.all || (visible && validation.visible.includes(s.key)));
        if (settings.length === 0) continue;
        if (section.group !== group) {
            group = section.group;
            t.print('');
            t.print(t.bold(`══ ${group.toUpperCase()} ${'═'.repeat(Math.max(2, 44 - group.length))}`));
        }
        t.print('');
        t.print(t.bold(`── ${section.title}`));
        for (const s of settings) {
            const v = current[s.key];
            const value = v.value ? display(v.value, s.type === 'secret', args.showSecrets) : t.dim(s.default ? `(default: ${s.default})` : '(not set)');
            const source = v.source === 'environment' ? t.yellow(' [environment]') : v.source === 'file' ? t.dim(' [env file]') : '';
            const problem = validation.errors[s.key] ? t.red(`  ✗ ${validation.errors[s.key]}`) : validation.warnings[s.key] ? t.yellow(`  ! ${validation.warnings[s.key]}`) : '';
            t.print(`  ${s.key.padEnd(28)} ${value}${source}${problem}`);
        }
    }
    t.print('');
    t.print(t.bold('── Project'));
    t.print(`  Prisma schema   ${project.schema.exists ? `${project.schema.models.length} model(s), ${project.schema.provider ?? '?'}` : 'missing'}`);
    t.print(`  Prisma client   ${project.client.generated ? 'generated' : t.red('not generated')}`);
    t.print(`  Generated code  ${project.generated.models} models, ${project.generated.routes} route files`);
    if (project.acl.missing.length) t.print(`  ACL             ${t.yellow(`no entry for: ${project.acl.missing.join(', ')}`)}`);
    t.print(`  User table      ${project.userModel ? project.userModel.model : 'none detected'}`);
    return Object.keys(validation.errors).length > 0 ? 1 : 0;
}

async function check(t: Terminal, sections: Section[], names: string[]): Promise<number> {
    const values = plainValues(currentValues(sections));
    const unknown = names.filter((n) => !['database', 'redis', 'ldap', 'oidc', 'webdav'].includes(n));
    if (unknown.length) { t.print(t.red(`Unknown check: ${unknown.join(', ')}`)); return 2; }
    const run = (names.length ? names : applicableChecks(values)) as CheckName[];
    let failed = 0;
    for (const name of run) {
        const result = await runCheck(name, values);
        printResult(t, name, result);
        if (!result.ok) failed++;
    }
    return failed > 0 ? 1 : 0;
}

/** Validate and write changes; prints what happened */
async function apply(t: Terminal, sections: Section[], project: ProjectInfo, changes: Values, yes: boolean): Promise<number> {
    const keys = Object.keys(changes);
    if (keys.length === 0) { t.print('No changes.'); return 0; }
    const values = { ...plainValues(currentValues(sections)), ...changes };
    const validation = validate(values, sections, project);
    const invalid = keys.filter((k) => validation.errors[k]);
    if (invalid.length) {
        for (const k of invalid) t.print(t.red(`  ✗ ${k}: ${validation.errors[k]}`));
        return 1;
    }
    t.print('');
    t.print(t.bold(`${keys.length} change(s) for ${envFilePath()}:`));
    const secrets = secretKeys(sections);
    for (const k of keys) t.print(`  ${k} = ${changes[k] === '' ? t.dim('(removed)') : display(changes[k]!, secrets.has(k))}`);
    if (!yes && !(await t.confirm('Write them?'))) { t.print('Nothing written.'); return 0; }
    const result = saveSettings(changes, sections);
    if (result.ignored.length) t.print(t.yellow(`  Not written — set by the environment, which wins over the file: ${result.ignored.join(', ')}`));
    t.print(t.green(`  ✓ Saved${result.backup ? ` (previous version: ${result.backup})` : ''}`));
    return 0;
}

/** Ask for one setting until the answer is valid; returns the new value or undefined to keep */
async function askSetting(t: Terminal, setting: Setting, values: Values, sections: Section[], project: ProjectInfo, locked: boolean): Promise<string | undefined | null> {
    const current = values[setting.key] ?? '';
    const secret = setting.type === 'secret';
    t.print('');
    t.print(`  ${t.bold(setting.label)}${t.dim(`  ${setting.key}`)}`);
    t.print(t.dim(`  ${setting.help}`));
    if (locked) {
        t.print(t.yellow(`  Set by the environment (${display(current, secret)}) — change it there.`));
        return undefined;
    }
    const hints: string[] = [];
    if (setting.type === 'enum' && setting.options?.length) hints.push(setting.options.join(' | '));
    if (setting.type === 'boolean') hints.push('true | false');
    if (setting.type === 'multi' && setting.options?.length) hints.push(`${setting.options.join(', ')} — comma-separated, in order`);
    if (secret && setting.generate) hints.push('g = generate');
    hints.push('Enter keeps', '- clears');
    const shown = current ? display(current, secret) : setting.default ? `default: ${setting.default}` : 'not set';
    for (let attempt = 0; attempt < 5; attempt++) {
        const answer = await t.ask(`  ${t.dim(`(${hints.join(' · ')})`)}\n  [${shown}] > `, secret);
        if (answer === null) return null; // end of input
        const trimmed = answer.trim();
        if (trimmed === '') return undefined;
        let value = trimmed === '-' ? '' : secret ? answer : trimmed;
        if (secret && setting.generate && trimmed === 'g') {
            value = generateSecret();
            t.print(t.green('  ✓ generated'));
        }
        if (setting.type === 'boolean' && /^(y|yes)$/i.test(value)) value = 'true';
        if (setting.type === 'boolean' && /^(n|no)$/i.test(value)) value = 'false';
        if (setting.type === 'multi') value = listItems(value).join(',');
        const error = validate({ ...values, [setting.key]: value }, sections, project).errors[setting.key];
        if (!error || value === '') return value;
        t.print(t.red(`  ✗ ${error}`));
    }
    return undefined;
}

async function interactive(t: Terminal, args: Args): Promise<number> {
    let project = await inspectProject(process.cwd(), process.env);
    const sections = buildSections(project);
    const current = currentValues(sections);
    const values = plainValues(current);
    const changes: Values = {};

    t.print(t.bold('Rapidd setup'));
    t.print(t.dim(`Env file: ${envFilePath()}${project.envFile.exists ? '' : ' (new)'}`));
    const reasons = await setupReasons();
    if (reasons.length) {
        t.print(t.yellow('The API cannot start yet:'));
        for (const r of reasons) t.print(t.yellow(`  · ${r.key}: ${r.message}`));
    }
    if (project.container) t.print(t.yellow('Running in a container: put the env file on a volume (ENV_FILE), or use --export for your orchestrator.'));
    t.print(t.dim('Enter keeps a value, - clears it, Ctrl+C stops without saving.'));

    const chosen = args.section ? sections.filter((s) => s.id === args.section) : sections;
    if (args.section && chosen.length === 0) {
        t.print(t.red(`Unknown section "${args.section}" — one of: ${sections.map((s) => s.id).join(', ')}`));
        return 2;
    }
    let group = '';
    for (const section of chosen) {
        if (!matches(section.when, values)) continue;
        if (section.group !== group) {
            group = section.group;
            t.print('');
            t.print(t.bold(`══ ${group.toUpperCase()} ${'═'.repeat(Math.max(2, 46 - group.length))}`));
        }
        t.print('');
        t.print(t.bold(`── ${section.title} ${'─'.repeat(Math.max(2, 46 - section.title.length))}`));
        t.print(t.dim(section.description));
        for (const setting of section.settings) {
            if (setting.advanced && !args.advanced) continue;
            if (!matches(setting.when, values)) continue;
            const answer = await askSetting(t, setting, values, sections, project, current[setting.key].locked);
            if (answer === null) { t.print('Input ended — nothing written.'); return 1; }
            if (answer !== undefined && answer !== values[setting.key]) {
                values[setting.key] = answer;
                changes[setting.key] = answer;
            }
        }
        if (section.check && (section.check !== 'redis' || values.REDIS_URL || values.REDIS_HOST)) {
            if (await t.confirm('\n  Test the connection now?')) {
                let username: string | undefined;
                let password: string | undefined;
                if (section.check === 'ldap' || section.check === 'webdav') {
                    username = (await t.ask('  Test user (Enter to skip): '))?.trim() || undefined;
                    if (username) password = (await t.ask('  Password: ', true)) ?? '';
                }
                printResult(t, section.check, await runCheck(section.check, values, { username, password }));
            }
        }
    }

    // Unset secrets that should exist
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET']) {
        if (!values[key] && !current[key].locked && !args.section) {
            values[key] = changes[key] = generateSecret();
            t.print(t.dim(`\n  ${key} was not set — generated one.`));
        }
    }

    const code = await apply(t, sections, project, changes, args.yes);
    if (code !== 0 || args.section) return code;

    // Schema, code and the first user
    project = await inspectProject(process.cwd(), process.env);
    const offers: [string, 'generate' | 'pull' | 'push' | 'migrate' | 'build', boolean][] = [
        ['Read the schema from the database (prisma db pull)?', 'pull', project.schema.models.length === 0],
        ['Generate the Prisma client (prisma generate)?', 'generate', !project.client.generated],
        ['Apply the migrations (prisma migrate deploy)?', 'migrate', project.migrations],
        ['Create the tables (prisma db push — only into an empty database)?', 'push', !project.migrations],
        ['Generate models, routes and ACL (rapidd build)?', 'build', project.generated.models === 0],
    ];
    for (const [question, action, relevant] of offers) {
        if (!relevant || await actionBlocker(action, values)) continue;
        if (!(await t.confirm(`\n${question}`, action !== 'pull'))) continue;
        t.print(t.dim('  running…'));
        const result = await runAction(action, values);
        t.print(`  ${result.ok ? t.green('✓') : t.red('✗')} ${result.message}`);
        if (!result.ok && result.output) t.print(t.dim(result.output.split('\n').slice(-15).map((l) => `    ${l}`).join('\n')));
    }

    const admin = await adminStatus(values);
    if (admin.available && admin.model && await t.confirm(`\nCreate the first ${admin.model.model} account?`)) {
        const input: Record<string, unknown> = {};
        for (const field of admin.model.fields) {
            const options = field.enumValues ? field.enumValues.join(' | ') : field.type !== 'String' ? field.type : '';
            const hint = [options, field.default ? `Enter = ${field.default}` : ''].filter(Boolean).join(', ');
            const hintText = hint ? ` (${hint})` : '';
            input[field.name] = (await t.ask(`  ${field.name}${field.required ? '*' : ''}${hintText}: `))?.trim() ?? '';
        }
        const password = await t.ask('  password (min. 8 characters): ', true);
        const repeat = await t.ask('  repeat password: ', true);
        if (password !== repeat) {
            t.print(t.red('  ✗ The passwords differ — no account created. Run npm run setup again to retry.'));
        } else {
            const result = await createFirstUser(values, { ...input, password });
            t.print(`  ${result.ok ? t.green('✓') : t.red('✗')} ${result.message}`);
            for (const [k, v] of Object.entries(result.errors ?? {})) t.print(t.red(`    ${k}: ${v}`));
        }
    }

    const remaining = await setupReasons();
    t.print('');
    if (remaining.length) {
        t.print(t.yellow('Still missing before the API can start:'));
        for (const r of remaining) t.print(t.yellow(`  · ${r.key}: ${r.message}`));
        return 1;
    }
    t.print(t.green('Setup complete — start the API with npm run dev (or npm start).'));
    return 0;
}

/** Entry point of `npm run setup`. Returns the exit code. */
export async function runCli(argv: string[], io: CliIO = { input: process.stdin, output: process.stdout }): Promise<number> {
    const args = parseArgs(argv);
    const t = new Terminal(io);
    try {
        if (args.help) { t.print(USAGE); return 0; }
        if (args.unknown.length) { t.print(`Unknown option: ${args.unknown.join(' ')}\n\n${USAGE}`); return 2; }
        if (args.envFile) reloadEnvFile(args.envFile);

        if (args.web) {
            t.close();
            const { runWebWizard } = await import('./server');
            await startOnFreePort(args, runWebWizard);
            return 0;
        }

        const project = await inspectProject(process.cwd(), process.env);
        const sections = buildSections(project);

        if (args.show) return show(t, sections, project, args);
        if (args.check) return await check(t, sections, args.check);
        if (args.export) {
            if (!['env', 'compose', 'kubernetes', 'shell'].includes(args.export)) { t.print(`Unknown format "${args.export}"`); return 2; }
            const keys = new Set(sections.flatMap((s) => s.settings.map((x) => x.key)));
            const values = plainValues(currentValues(sections));
            io.output.write(exportSettings(Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k))), args.export as ExportFormat, sections));
            return 0;
        }
        if (args.set.length || args.unset.length || args.generateSecrets) {
            const changes: Values = {};
            for (const [k, v] of args.set) changes[k] = v;
            for (const k of args.unset) changes[k] = '';
            if (args.generateSecrets) {
                for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET']) if (!process.env[key] && !(key in changes)) changes[key] = generateSecret();
            }
            return await apply(t, sections, project, changes, true);
        }
        return await interactive(t, args);
    } finally {
        t.close();
    }
}

/** The web wizard on the requested port, or the next free one (the API may be running on PORT) */
async function startOnFreePort(args: Args, run: typeof import('./server').runWebWizard): Promise<void> {
    const first = args.port ?? Number(process.env.PORT || 3000);
    for (let port = first; port < first + 10; port++) {
        try {
            await run({ mode: 'explicit', host: args.host ?? '127.0.0.1', port });
            return;
        } catch (err: any) {
            if (err?.code !== 'EADDRINUSE' || args.port) throw err;
        }
    }
    throw new Error(`No free port between ${first} and ${first + 9}`);
}

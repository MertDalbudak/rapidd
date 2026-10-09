import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { PassThrough } from 'stream';
import { runCli } from '../../src/setup/cli';

const saved = { ...process.env };
const cwd = process.cwd();

async function cli(argv: string[], answers: string[] = []): Promise<{ code: number; out: string }> {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c) => { out += c.toString(); });
    input.end(answers.length ? answers.join('\n') + '\n' : '');
    const code = await runCli(argv, { input, output, tty: false });
    return { code, out };
}

describe('npm run setup (CLI)', () => {
    let dir: string;
    const envFile = () => path.join(dir, '.env');
    const written = () => dotenv.parse(fs.readFileSync(envFile()));

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-cli-'));
        fs.mkdirSync(path.join(dir, 'prisma'));
        fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n}\n');
        process.chdir(dir);
        process.env.ENV_FILE = envFile();
        for (const k of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET', 'LOG_FORMAT', 'API_TIMEZONE', 'PORT', 'PAGINATION_MODE', 'API_RESULT_LIMIT']) {
            delete process.env[k];
        }
    });
    afterEach(() => {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('--help and unknown options', async () => {
        expect(await cli(['--help'])).toMatchObject({ code: 0, out: expect.stringContaining('Usage: npm run setup') });
        expect((await cli(['--frobnicate'])).code).toBe(2);
    });

    it('--set validates, then writes; --unset removes', async () => {
        const bad = await cli(['--set', 'PORT=abc']);
        expect(bad.code).toBe(1);
        expect(bad.out).toContain('PORT: A whole number');
        expect(fs.existsSync(envFile())).toBe(false);

        expect((await cli(['--set', 'DATABASE_URL=postgresql://u:p@h/db', '--set', 'LOG_FORMAT=json'])).code).toBe(0);
        expect(written()).toEqual({ DATABASE_URL: 'postgresql://u:p@h/db', LOG_FORMAT: 'json' });

        expect((await cli(['--unset', 'LOG_FORMAT'])).code).toBe(0);
        expect(written()).toEqual({ DATABASE_URL: 'postgresql://u:p@h/db' });
    });

    it('--generate-secrets fills only unset secrets', async () => {
        process.env.COOKIE_SECRET = 'from-the-environment-0123456789';
        expect((await cli(['--generate-secrets'])).code).toBe(0);
        const env = written();
        expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
        expect(env.JWT_REFRESH_SECRET).toMatch(/^[0-9a-f]{64}$/);
        expect(env.JWT_SECRET).not.toBe(env.JWT_REFRESH_SECRET);
        expect(env.COOKIE_SECRET).toBeUndefined();
    });

    it('--show: values, sources, problems; secrets masked unless asked; exit 1 while invalid', async () => {
        fs.writeFileSync(envFile(), 'JWT_SECRET=supersecretvalue0123456789\nLOG_LEVEL=loud\n');
        process.env.PORT = '4000';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../src/setup/envfile').reloadEnvFile(envFile());
        const shown = await cli(['--show']);
        expect(shown.code).toBe(1); // DATABASE_URL is required
        expect(shown.out).toMatch(/PORT\s+4000 \[environment\]/);
        expect(shown.out).toMatch(/JWT_SECRET\s+••••••6789 \[env file\]/);
        expect(shown.out).toMatch(/LOG_LEVEL\s+loud \[env file\]\s+✗ One of: essential, fine, finest/);
        expect(shown.out).toMatch(/DATABASE_URL\s+\(not set\)\s+✗ Required/);
        expect(shown.out).not.toContain('supersecretvalue');
        expect((await cli(['--show', '--show-secrets'])).out).toContain('supersecretvalue0123456789');
    });

    it('--export prints the configuration (with secrets) for another home', async () => {
        await cli(['--set', 'DATABASE_URL=postgresql://u:p@h/db', '--set', "AUTH_DEFAULT_ROLE=it's"]);
        const { code, out } = await cli(['--export', 'shell']);
        expect(code).toBe(0);
        expect(out).toContain("export DATABASE_URL='postgresql://u:p@h/db'");
        expect(out).toContain("export AUTH_DEFAULT_ROLE='it'\\''s'");
        expect((await cli(['--export', 'xml'])).code).toBe(2);
    });

    it('--check reports failures with a non-zero exit code', async () => {
        process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/db';
        const { code, out } = await cli(['--check', 'database']);
        expect(code).toBe(1);
        expect(out).toContain('✗ database — Connection refused');
        expect((await cli(['--check', 'smtp'])).code).toBe(2);
    });

    it('interactive: asks, re-asks invalid answers, confirms, writes', async () => {
        const answers = [
            '250',           // API_RESULT_LIMIT
            '',              // API_INCLUDE_RESULT_LIMIT: keep
            'page',          // PAGINATION_MODE
            'Mars/Base',     // API_TIMEZONE: invalid ...
            'Europe/Berlin', // ... asked again
            '',              // DEFAULT_LANGUAGE: keep
            'y',             // write?
        ];
        const { code, out } = await cli(['--section', 'api'], answers);
        expect(out).toContain('✗ Unknown timezone');
        expect(out).toContain('3 change(s)');
        expect(code).toBe(0);
        expect(written()).toEqual({ API_RESULT_LIMIT: '250', PAGINATION_MODE: 'page', API_TIMEZONE: 'Europe/Berlin' });
    });

    it('interactive: answering no writes nothing; running out of input aborts', async () => {
        // LOG_LEVEL keep, LOG_FORMAT json, LOG_DIR keep, write? no
        expect((await cli(['--section', 'logging'], ['', 'json', '', 'n'])).out).toContain('Nothing written');
        expect(fs.existsSync(envFile())).toBe(false);
        const ended = await cli(['--section', 'logging'], ['fine']);
        expect(ended).toMatchObject({ code: 1, out: expect.stringContaining('nothing written') });
        expect((await cli(['--section', 'nope'])).code).toBe(2);
    });
});

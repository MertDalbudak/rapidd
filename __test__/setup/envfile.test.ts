import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { formatEnvValue, updateEnvContent, writeEnvFile, loadEnvFile, valueSource, readEnvFile } from '../../src/setup/envfile';
import type { EnvLayout } from '../../src/setup/envfile';

describe('formatEnvValue — dotenv reads back exactly the same string', () => {
    it.each([
        ['plain', 'abc123'],
        ['empty', ''],
        ['URL with query', 'postgresql://u:p%40ss@db:5432/app?schema=public'],
        ['spaces', '  padded value  '],
        ['hash', 'pass#word'],
        ['leading hash', '#notacomment'],
        ['JSON', '{"CN=App Admins,OU=Groups,DC=corp":"admin","role:editor":"editor"}'],
        ['single quotes', "it's"],
        ['double quotes', 'say "hi"'],
        ['both quote kinds', 'it\'s "quoted"'],
        ['backslash n literally', 'C:\\new\\path'],
        ['newlines (PEM)', '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----'],
        ['dollar', 'pa$$word ${NOT_EXPANDED}'],
        ['equals', 'a=b=c'],
    ])('%s', (_name, value) => {
        const line = `KEY=${formatEnvValue(value)}`;
        expect(dotenv.parse(line).KEY).toBe(value);
    });

    it('refuses values no quoting can represent', () => {
        expect(() => formatEnvValue('\'"`\n#')).toThrow(/cannot be written/);
    });
});

describe('updateEnvContent', () => {
    const example = [
        '# ── Database ─────',
        '# the connection',
        'DATABASE_URL=postgresql://old',
        '',
        '# ── Logging ─────',
        'LOG_LEVEL=essential # inline comment',
        'export LOG_FORMAT=text',
        '',
    ].join('\n');

    it('replaces in place and keeps comments, order and the trailing newline', () => {
        const out = updateEnvContent(example, { DATABASE_URL: 'postgresql://new', LOG_FORMAT: 'json' });
        expect(out).toBe(example.replace('postgresql://old', 'postgresql://new').replace('export LOG_FORMAT=text', 'LOG_FORMAT=json'));
    });

    it('removes keys', () => {
        const out = updateEnvContent(example, { LOG_LEVEL: null });
        expect(out).not.toContain('LOG_LEVEL');
        expect(dotenv.parse(out)).toEqual({ DATABASE_URL: 'postgresql://old', LOG_FORMAT: 'text' });
    });

    const layout: EnvLayout = { sections: [
        { title: 'Server', group: 'Server', keys: ['PORT'] },
        { title: 'Database', group: 'Data stores', keys: ['DATABASE_URL'] },
        { title: 'Redis', group: 'Data stores', keys: ['REDIS_URL'] },
        { title: 'Tokens', group: 'Authentication', keys: ['JWT_SECRET'] },
        { title: 'Logging', group: 'Operations', keys: ['LOG_LEVEL', 'LOG_FORMAT', 'LOG_DIR'] },
    ] };

    it('adds new keys under their heading, and missing headings where the layout puts them', () => {
        const out = updateEnvContent(example, { LOG_DIR: '/var/log/app', REDIS_URL: 'redis://r:6379', PORT: '4000' }, layout);
        const lines = out.split('\n');
        expect(lines.indexOf('LOG_DIR=/var/log/app')).toBe(lines.indexOf('export LOG_FORMAT=text') + 1);
        // No banners in a file that has headings but none: just headings, in layout order
        expect(out).not.toContain('═');
        const order = ['# ── Server', '# ── Database', '# ── Redis', '# ── Logging'].map((h) => lines.findIndex((l) => l.startsWith(h)));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(lines[lines.findIndex((l) => l.startsWith('# ── Redis')) + 1]).toBe('REDIS_URL=redis://r:6379');
    });

    it('builds a new file in layout order, grouped under banners; unknown keys last', () => {
        const out = updateEnvContent('', { LOG_LEVEL: 'fine', APP_FLAG: 'on', JWT_SECRET: 'x', DATABASE_URL: 'postgresql://h/db' }, layout);
        const structure = out.split('\n').filter((l) => /^#  [A-Z]|^# ──|^[A-Z]/.test(l)).map((l) => l.replace(/ ─+$/, ''));
        expect(structure).toEqual([
            '#  DATA STORES', '# ── Database', 'DATABASE_URL=postgresql://h/db',
            '#  AUTHENTICATION', '# ── Tokens', 'JWT_SECRET=x',
            '#  OPERATIONS', '# ── Logging', 'LOG_LEVEL=fine',
            '#  OTHER', '# ── Other', 'APP_FLAG=on',
        ]);
        expect(out).not.toMatch(/\n\n\n/);
    });

    it('fills a group whose banner exists, and places a new group between existing ones', () => {
        const content = updateEnvContent('', { PORT: '1', LOG_LEVEL: 'fine' }, layout);
        const out = updateEnvContent(content, { JWT_SECRET: 's', DATABASE_URL: 'postgresql://h/db' }, layout);
        const heads = out.split('\n').filter((l) => /^#  [A-Z]/.test(l));
        expect(heads).toEqual(['#  SERVER', '#  DATA STORES', '#  AUTHENTICATION', '#  OPERATIONS']);
        expect(dotenv.parse(out)).toEqual({ PORT: '1', DATABASE_URL: 'postgresql://h/db', JWT_SECRET: 's', LOG_LEVEL: 'fine' });
    });

    it('matches headings with a hint after the title', () => {
        const content = '# ── LDAP / Active Directory (AUTH_PROVIDERS=ldap) ──\nLDAP_URL=ldaps://a\n';
        const ldap: EnvLayout = { sections: [{ title: 'LDAP / Active Directory', group: 'Authentication', keys: ['LDAP_URL', 'LDAP_TIMEOUT'] }] };
        expect(updateEnvContent(content, { LDAP_TIMEOUT: '3000' }, ldap)).toBe(`${content}LDAP_TIMEOUT=3000\n`);
    });

    it('collapses duplicate assignments and replaces multi-line values entirely', () => {
        const content = 'A=1\nKEY="line1\nline2"\nB=2\nA=3\n';
        const out = updateEnvContent(content, { KEY: 'x', A: 'y' });
        expect(out).toBe('A=y\nKEY=x\nB=2\n');
    });

    it('keeps CRLF line endings', () => {
        expect(updateEnvContent('A=1\r\nB=2\r\n', { B: '3' })).toBe('A=1\r\nB=3\r\n');
    });

    it('builds a file from nothing', () => {
        const out = updateEnvContent('', { PORT: '1' }, { sections: [{ title: 'Server', group: 'Server', keys: ['PORT'] }] });
        // The same 60-column lines as .env.example
        expect(out).toBe(`# ${'═'.repeat(58)}\n#  SERVER\n# ${'═'.repeat(58)}\n\n${'# ── Server '.padEnd(60, '─')}\nPORT=1\n`);
        const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
        expect(example).toContain(`${'# ── Server '.padEnd(60, '─')}\n`);
    });
});

describe('env file on disk', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-env-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('writes atomically with owner-only permissions and keeps a backup', () => {
        const file = path.join(dir, '.env');
        expect(writeEnvFile(file, 'A=1\n').backup).toBeNull();
        expect(writeEnvFile(file, 'A=2\n').backup).toBe(`${file}.bak`);
        expect(fs.readFileSync(file, 'utf8')).toBe('A=2\n');
        expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe('A=1\n');
        if (process.platform !== 'win32') {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.statSync(`${file}.bak`).mode & 0o777).toBe(0o600);
        }
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('loads without overriding the real environment and remembers the source', () => {
        const file = path.join(dir, '.env');
        fs.writeFileSync(file, 'RAPIDD_T_FILE=from-file\nRAPIDD_T_BOTH=from-file\n');
        process.env.RAPIDD_T_BOTH = 'from-env';
        try {
            loadEnvFile(file);
            expect(process.env.RAPIDD_T_FILE).toBe('from-file');
            expect(process.env.RAPIDD_T_BOTH).toBe('from-env');
            expect(valueSource('RAPIDD_T_FILE')).toBe('file');
            expect(valueSource('RAPIDD_T_BOTH')).toBe('environment');
            expect(valueSource('RAPIDD_T_NONE')).toBe('unset');
        } finally {
            for (const k of ['RAPIDD_T_FILE', 'RAPIDD_T_BOTH']) delete process.env[k];
        }
    });

    it('reads a missing file as empty', () => {
        expect(readEnvFile(path.join(dir, 'nope'))).toEqual({ exists: false, content: '', values: {} });
    });
});

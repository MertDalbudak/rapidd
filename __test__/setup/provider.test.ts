import fs from 'fs';
import os from 'os';
import path from 'path';
import { alignSchemaProvider, cliDatabaseUrl, clientProvider, schemaProvider } from '../../src/setup/project';
import { validate, buildSections } from '../../src/setup/settings';
import { setupReasons } from '../../src/setup';

const SCAFFOLD = 'generator client {\n  provider = "prisma-client-js"\n  output   = "client"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n';

describe('the schema follows the database while it has no models', () => {
    let dir: string;
    const schemaFile = () => path.join(dir, 'prisma', 'schema.prisma');
    const saved = { ...process.env };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-provider-'));
        fs.mkdirSync(path.join(dir, 'prisma'));
        fs.writeFileSync(schemaFile(), SCAFFOLD);
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('a MySQL / MariaDB database switches the scaffold (postgresql) to mysql — only the provider line changes', () => {
        expect(alignSchemaProvider(dir, 'mariadb://u:p@h/db')).toEqual({ changed: true, from: 'postgresql', to: 'mysql' });
        expect(fs.readFileSync(schemaFile(), 'utf8')).toBe(SCAFFOLD.replace('provider = "postgresql"', 'provider = "mysql"'));
        // the generator's provider is untouched
        expect(fs.readFileSync(schemaFile(), 'utf8')).toContain('provider = "prisma-client-js"');
        expect(alignSchemaProvider(dir, 'mysql://u:p@h/db')).toMatchObject({ changed: false });
        expect(alignSchemaProvider(dir, 'postgres://u:p@h/db')).toEqual({ changed: true, from: 'mysql', to: 'postgresql' });
    });

    it('a schema with models is never changed', () => {
        fs.appendFileSync(schemaFile(), '\nmodel user {\n  id Int @id\n}\n');
        expect(alignSchemaProvider(dir, 'mysql://u:p@h/db')).toMatchObject({ changed: false, from: 'postgresql' });
        expect(schemaProvider(fs.readFileSync(schemaFile(), 'utf8'))).toBe('postgresql');
    });

    it('the wizard warns (no models yet) or refuses (models) a URL for another database', () => {
        const fresh = validate({ DATABASE_URL: 'mysql://u:p@h/db' }, buildSections(), { schema: { provider: 'postgresql', models: [] } as any });
        expect(fresh.errors.DATABASE_URL).toBeUndefined();
        expect(fresh.warnings.DATABASE_URL).toMatch(/switches it to mysql/);
        const modeled = validate({ DATABASE_URL: 'mysql://u:p@h/db' }, buildSections(), { schema: { provider: 'postgresql', models: ['user'] } as any });
        expect(modeled.errors.DATABASE_URL).toMatch(/schema is for postgresql/);
    });

    it('Prisma\'s CLI gets mysql:// for a mariadb:// URL', () => {
        expect(cliDatabaseUrl('mariadb://u:p@h:3306/db')).toBe('mysql://u:p@h:3306/db');
        expect(cliDatabaseUrl('postgresql://u:p@h/db')).toBe('postgresql://u:p@h/db');
    });

    it('a client generated for another provider keeps the API from starting', async () => {
        process.env.DATABASE_URL = 'mysql://u:p@h/db';
        alignSchemaProvider(dir, process.env.DATABASE_URL);
        fs.mkdirSync(path.join(dir, 'prisma', 'client'));
        fs.writeFileSync(path.join(dir, 'prisma', 'client', 'index.js'), 'module.exports = {};');
        fs.writeFileSync(path.join(dir, 'prisma', 'client', 'schema.prisma'), SCAFFOLD); // built for postgresql
        expect(clientProvider(dir)).toBe('postgresql');
        expect(await setupReasons(dir)).toEqual([{ key: 'prisma/client', message: 'The Prisma client was generated for postgresql — generate it again for mysql' }]);
        fs.writeFileSync(path.join(dir, 'prisma', 'client', 'schema.prisma'), SCAFFOLD.replace('postgresql', 'mysql'));
        expect(await setupReasons(dir)).toEqual([]);
    });
});

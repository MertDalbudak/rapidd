import { parseMySQLConnectionString, splitPostgresSchema, createAdapter } from '../../src/core/adapter';

describe('PostgreSQL URLs', () => {
    it("Prisma's own parameters go to the adapter and the pool, not to pg", () => {
        expect(splitPostgresSchema('postgresql://u:p@h:5432/db?schema=store&sslmode=require&connection_limit=25&pool_timeout=5')).toEqual({
            connectionString: 'postgresql://u:p@h:5432/db?sslmode=require', schema: 'store', max: 25, connectionTimeoutMillis: 5000,
        });
        expect(splitPostgresSchema('postgresql://u:p@h/db')).toEqual({ connectionString: 'postgresql://u:p@h/db' });
        expect(splitPostgresSchema('')).toEqual({ connectionString: '' });
    });

    it('the adapter queries the schema of ?schema=', () => {
        const { adapter, pool } = createAdapter('postgresql://u:p@h/db?schema=store&connection_limit=3') as any;
        expect(adapter.options).toEqual({ schema: 'store' });
        expect(pool.options.max).toBe(3);
    });
});

describe('MySQL / MariaDB URLs', () => {
    it('credentials are URL-decoded; MySQL 8 key retrieval is on unless turned off', () => {
        expect(parseMySQLConnectionString('mysql://u:p%40ss@h/db')).toEqual({
            host: 'h', port: 3306, user: 'u', password: 'p@ss', database: 'db', connectionLimit: 10, allowPublicKeyRetrieval: true,
        });
        expect(parseMySQLConnectionString('mysql://u:p@h/db?allowPublicKeyRetrieval=false').allowPublicKeyRetrieval).toBe(false);
    });

    it("Prisma's MySQL URL parameters apply", () => {
        expect(parseMySQLConnectionString('mariadb://u:p@h:3307/db?connection_limit=4&connect_timeout=5&socket_timeout=30&socket=/tmp/my.sock&sslaccept=accept_invalid_certs'))
            .toMatchObject({ port: 3307, connectionLimit: 4, connectTimeout: 5000, socketTimeout: 30000, socketPath: '/tmp/my.sock', ssl: { rejectUnauthorized: false } });
        expect(parseMySQLConnectionString('mysql://u:p@h/db?ssl=true').ssl).toEqual({ rejectUnauthorized: true });
        expect(parseMySQLConnectionString('mysql://u:p@h/db').ssl).toBeUndefined();
    });
});

describe('database drivers', () => {
    it('an installed driver loads', () => {
        const { requireDriver } = require('../../src/core/adapter');
        expect(requireDriver('pg').Pool).toBeDefined();
    });

    it('a missing driver names the database (an image built for the other one)', () => {
        jest.isolateModules(() => {
            jest.doMock('mariadb', () => {
                throw Object.assign(new Error("Cannot find module 'mariadb' from 'src/core/adapter.ts'"), { code: 'MODULE_NOT_FOUND' });
            });
            const { requireDriver, createAdapter: create } = require('../../src/core/adapter');
            expect(() => requireDriver('mariadb')).toThrow("mariadb is not installed, so MySQL/MariaDB databases can't be used");
            jest.doMock('@prisma/adapter-mariadb', () => {
                throw Object.assign(new Error("Cannot find module '@prisma/adapter-mariadb'"), { code: 'MODULE_NOT_FOUND' });
            });
            expect(() => create('mysql://u:p@h/db')).toThrow(/@prisma\/adapter-mariadb is not installed.*prisma\/schema\.prisma/);
        });
    });

    it('other load errors pass through', () => {
        jest.isolateModules(() => {
            jest.doMock('pg', () => { throw new Error('native binding failed'); });
            const { requireDriver } = require('../../src/core/adapter');
            expect(() => requireDriver('pg')).toThrow('native binding failed');
        });
    });
});

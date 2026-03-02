#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMMANDS = { 'create-project': createProject };

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
    console.log('Usage: npx rapidd <command>\n');
    console.log('Commands:');
    console.log('  create-project   Scaffold a new Rapidd project in the current directory');
    console.log('  build            Generate models, routes & ACL from Prisma schema (@rapidd/build)');
    process.exit(0);
}

if (COMMANDS[command]) {
    COMMANDS[command](args.slice(1));
} else if (command === 'build') {
    // Proxy to @rapidd/build
    try {
        const buildBin = require.resolve('@rapidd/build/bin/cli.js');
        execFileSync(process.execPath, [buildBin, ...args], { stdio: 'inherit' });
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            console.error('@rapidd/build is not installed.\n');
            console.error('  npm install -D @rapidd/build');
            process.exit(1);
        }
        process.exit(err.status ?? 1);
    }
} else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

function createProject() {
    const targetDir = process.cwd();

    // Safety check — don't overwrite an existing project
    if (fs.existsSync(path.join(targetDir, 'src')) || fs.existsSync(path.join(targetDir, 'main.ts'))) {
        console.error('Error: Current directory already contains a project (src/ or main.ts found).');
        process.exit(1);
    }

    const packageRoot = path.resolve(__dirname, '..');
    const projectName = path.basename(targetDir);

    const SKIP = new Set([
        'node_modules', 'dist', '__test__', '.github', '.claude', 'wiki',
        'bin', '.git', 'package-lock.json', '.env', 'prisma/client',
    ]);

    const FILES = [
        'src/',
        'config/',
        'locales/',
        'routes/',
        'templates/',
        'public/',
        'prisma/schema.prisma',
        'prisma.config.ts',
        'main.ts',
        'tsconfig.json',
        '.env.example',
        '.gitignore',
        '.dockerignore',
        'dockerfile',
    ];

    console.log(`\nCreating project in ${targetDir}...\n`);

    for (const entry of FILES) {
        const src = path.join(packageRoot, entry);
        if (!fs.existsSync(src)) continue;

        const dest = path.join(targetDir, entry);

        if (entry.endsWith('/')) {
            copyDir(src, dest, SKIP);
        } else {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    }

    // Read versions from this package's own package.json so they never drift
    const corePkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    const coreDeps = corePkg.dependencies || {};
    const coreDevDeps = corePkg.devDependencies || {};

    function pick(source, keys) {
        const result = {};
        for (const key of keys) {
            if (source[key]) result[key] = source[key];
        }
        return result;
    }

    // Generate a fresh package.json for the new project
    const pkg = {
        name: projectName,
        version: '1.0.0',
        private: true,
        scripts: {
            start: 'node dist/main.js',
            dev: 'tsx watch main.ts',
            build: 'tsc',
        },
        engines: corePkg.engines || { node: '>=24.0.0' },
        dependencies: pick(coreDeps, [
            '@fastify/cookie', '@fastify/cors', '@fastify/formbody', '@fastify/multipart', '@fastify/static',
            '@prisma/adapter-mariadb', '@prisma/adapter-pg', '@prisma/client', '@prisma/internals',
            'bcrypt', 'dotenv', 'ejs', 'fastify', 'fastify-plugin',
            'ioredis', 'jsonwebtoken', 'luxon', 'nodemailer', 'pg',
        ]),
        devDependencies: pick(coreDevDeps, [
            '@rapidd/build',
            '@types/bcrypt', '@types/ejs', '@types/jsonwebtoken', '@types/luxon',
            '@types/node', '@types/nodemailer', '@types/pg',
            'prisma', 'tsx', 'typescript',
        ]),
    };

    fs.writeFileSync(
        path.join(targetDir, 'package.json'),
        JSON.stringify(pkg, null, 2) + '\n'
    );

    console.log('Project created. Next steps:\n');
    console.log('  npm install');
    console.log('  # Set DATABASE_URL in .env');
    console.log('  npx prisma db pull');
    console.log('  npx rapidd build');
    console.log('  npm run dev\n');
}

function copyDir(src, dest, skip) {
    fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (skip.has(entry.name) || entry.name === '.DS_Store') continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath, skip);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

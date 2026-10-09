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

/** A package's bin script, resolved from the project (null when not installed) */
function resolveBin(pkg, cwd) {
    try {
        const manifest = require.resolve(`${pkg}/package.json`, { paths: [cwd] });
        const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
        const rel = typeof bin === 'string' ? bin : bin && Object.values(bin)[0];
        return rel ? path.join(path.dirname(manifest), rel) : null;
    } catch {
        return null;
    }
}

function run(script, scriptArgs) {
    try {
        execFileSync(process.execPath, [script, ...scriptArgs], { stdio: 'inherit' });
    } catch (err) {
        process.exit(err.status ?? 1);
    }
}

if (COMMANDS[command]) {
    COMMANDS[command](args.slice(1));
} else if (command === 'build') {
    // Proxy to @rapidd/build
    const buildBin = resolveBin('@rapidd/build', process.cwd());
    if (!buildBin) {
        console.error('@rapidd/build is not installed.\n');
        console.error('  npm install -D @rapidd/build');
        process.exit(1);
    }
    run(buildBin, args);
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

    // Junk / build artifacts — skipped wherever they appear (matched by basename).
    const SKIP_NAMES = new Set([
        'node_modules', 'dist', '__test__', '.github', '.claude', 'wiki',
        'bin', '.git', 'package-lock.json', '.env', '.DS_Store',
    ]);

    // App-specific artifacts — matched by EXACT project-relative path so a framework
    // core file that merely shares a basename (e.g. src/core/user.ts) is never dropped.
    // `rapidd build` regenerates these from the user's own schema.
    const SKIP_PATHS = new Set([
        'src/models',         // generated model subclasses
        'src/config/acl.ts',  // build regenerates a permissive scaffold
        'src/config/user.ts', // build regenerates the default-user stub
        'prisma/client',      // generated Prisma client
    ]);

    const FILES = [
        'src/',
        'config/',
        'locales/',
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
        const rel = entry.replace(/\/$/, ''); // project-relative path (posix, no trailing slash)

        if (entry.endsWith('/')) {
            copyDir(src, dest, rel, SKIP_NAMES, SKIP_PATHS);
        } else {
            if (SKIP_PATHS.has(rel) || SKIP_NAMES.has(path.basename(rel))) continue;
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
            setup: 'tsx main.ts setup',
            build: 'tsc',
        },
        engines: corePkg.engines || { node: '^22.12.0 || >=24.0.0' },
        dependencies: pick(coreDeps, [
            '@fastify/cookie', '@fastify/cors', '@fastify/formbody', '@fastify/multipart', '@fastify/proxy-addr', '@fastify/static',
            '@prisma/adapter-mariadb', '@prisma/adapter-pg', '@prisma/client', '@prisma/internals',
            'bcrypt', 'dotenv', 'fastify', 'fastify-plugin',
            'ioredis', 'jsonwebtoken', 'pg',
        ]),
        devDependencies: pick(coreDevDeps, [
            '@rapidd/build',
            '@types/bcrypt', '@types/jsonwebtoken',
            '@types/node', '@types/pg',
            'prisma', 'tsx', 'typescript',
        ]),
    };

    fs.writeFileSync(
        path.join(targetDir, 'package.json'),
        JSON.stringify(pkg, null, 2) + '\n'
    );

    console.log('Project created. Next steps:\n');
    console.log('  npm install');
    console.log('  npm run dev      # opens the setup wizard in the browser on first start');
    console.log('  npm run setup    # the setup wizard, any time\n');
}

function copyDir(src, dest, rel, skipNames, skipPaths) {
    fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (skipNames.has(entry.name)) continue;

        const childRel = rel ? `${rel}/${entry.name}` : entry.name; // posix project-relative path
        if (skipPaths.has(childRel)) continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath, childRel, skipNames, skipPaths);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

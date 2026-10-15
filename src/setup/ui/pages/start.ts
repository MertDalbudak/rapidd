// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Overview, Database, Sign-in, First user and the complete Environment */
export function installStartPages(R) {
    const h = R.h;
    const S = R.S;
    const AUTH_SECTIONS = ['providers', 'tokens', 'sessions', 'transport', 'users', 'identities', 'ldap', 'oidc', 'saml', 'webdav'];

    /** AUTH_PROVIDERS=none: no sign-in, every request is anonymous */
    R.signInOff = () => (R.value('AUTH_PROVIDERS') || '').split(',').map((x) => x.trim().toLowerCase()).includes('none');

    /** The page that fixes a setup reason */
    R.pageFor = (key) => {
        if (/^(DATABASE_|REDIS_)/.test(key)) return 'database';
        if (/^(JWT_|AUTH_|LDAP_|OIDC_|WEBDAV_|DB_USER_)/.test(key)) return 'signin';
        if (key === 'prisma/client' || key === 'prisma/schema.prisma') return 'model';
        if (/rls\.json$/.test(key)) return 'rls';
        return 'environment';
    };
    R.fix = (key) => {
        const page = R.pageFor(key);
        if (page === 'environment') S.ui.envSearch = key;
        R.go(page);
    };

    /** Back / next through the setup steps */
    R.pager = (back, next) => h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '6px' } },
        back ? R.button(R.byId[back].title, { kind: 'ghost', icon: 'chevronLeft', onClick: () => R.go(back) }) : h('span'),
        next ? R.button(R.byId[next].title, { kind: 'primary', icon: 'chevronRight', onClick: () => R.go(next) }) : h('span'));

    // ── Overview ─────────────────────────────────────────────────────────
    function checklist() {
        const p = S.state.project;
        const services = Object.keys((R.fileJson('app', {}) || {}).services || {}).length;
        const limits = Object.keys(R.fileJson('rateLimit', {}) || {}).length;
        const steps = [
            { page: 'database', title: 'Database', state: R.byId.database.status(),
                text: R.hasValue('DATABASE_URL') ? (S.checks.database && S.checks.database.ok ? 'Connected — ' + S.checks.database.message : 'Connection string set' + (S.checks.database ? '' : ' — test it')) : 'Connect the API to PostgreSQL, MySQL or MariaDB' },
            { page: 'model', title: 'Data model & API', state: R.byId.model.status(),
                text: p.schema.error ? 'The schema has errors' : p.schema.models.length === 0 ? 'Read the tables from the database, or create them from the schema'
                    : p.schema.models.length + ' models · ' + (p.client.generated ? 'client generated' : 'client not generated') + ' · ' + p.generated.routes + ' route files' },
            { page: 'signin', title: 'Sign-in', state: R.byId.signin.status(),
                text: R.signInOff() ? 'No sign-in — every request is anonymous' : 'Identity providers, tokens and sessions — ' + (R.value('AUTH_PROVIDERS') || 'local') },
            { page: 'admin', title: 'First user', state: R.byId.admin.status(), optional: true,
                text: R.signInOff() ? 'Not needed — there is no sign-in' : S.admin ? (S.admin.available ? 'The user table is empty — create the first account' : S.admin.reason) : 'The first account, while the user table is empty' },
            { page: 'model', title: 'Access control', state: p.schema.models.length === 0 ? '' : p.acl.error ? 'bad' : p.acl.missing.length ? 'warn' : 'ok',
                text: p.acl.error ? 'src/config/acl.ts does not load: ' + p.acl.error
                    : p.schema.models.length === 0 ? 'In code — src/config/acl.ts'
                        : p.acl.missing.length ? p.acl.missing.length + ' of ' + p.schema.models.length + ' models without an entry in src/config/acl.ts' : 'Every model has an entry in src/config/acl.ts' },
            { page: 'rls', title: 'Row-level security', state: '', text: 'Database-enforced isolation (PostgreSQL)', optional: true },
            { page: 'services', title: 'Services', state: '', text: services ? services + ' external API' + (services === 1 ? '' : 's') + ' configured' : 'APIs your app calls with ApiClient', optional: true },
            { page: 'ratelimits', title: 'Rate limits', state: '', text: limits ? limits + ' path rule' + (limits === 1 ? '' : 's') : 'Default limit only', optional: true },
        ];
        return R.card({ title: 'Setup steps', description: 'Required steps first; the optional ones can wait.', body: 'flush' },
            h('ul', { class: 'checklist' }, steps.map((s, i) => h('li', null,
                h('span', { class: 'mark ' + (s.state || '') }, s.state === 'ok' ? R.icon('check') : s.state === 'bad' ? R.icon('x') : s.state === 'warn' ? R.icon('alert') : String(i + 1)),
                h('div', { class: 'text' }, h('b', { text: s.title }), s.optional ? h('span', { style: { marginLeft: '8px' } }, R.badge('Optional', 'outline')) : null, h('div', { text: s.text })),
                R.button('Open', { size: 'sm', icon: 'chevronRight', onClick: () => R.go(s.page) })))));
    }

    function overview() {
        const st = S.state;
        const p = st.project;
        const first = st.reasons.length > 0;
        const out = [];
        out.push(h('div', { class: 'hero' },
            h('img', { src: '/setup/assets/logo.png', alt: '' }),
            h('div', null,
                h('h1', { text: first ? 'Set up ' + st.app.name : R.command() ? st.app.name + ' is configured' : st.app.name + ' is ready to start' }),
                h('p', { text: R.command()
                    ? 'Opened with npm run setup. Change what you need — nothing is written before you save; finishing saves and ends the setup.'
                    : first ? 'Rapidd serves this setup until the API can start. Work through the steps — nothing is written before you save, and the API starts when you finish.'
                        : st.mode === 'on' ? 'Opened with SETUP_WIZARD=on: change what you need, then save and start the API.' : 'Everything the API needs is configured. Review your changes and start it.' })),
            h('div', { class: 'actions' },
                first ? R.button('Start with the database', { kind: 'primary', icon: 'chevronRight', onClick: () => R.go('database') })
                    : R.button(R.finishTitle(), { kind: 'primary', icon: 'flag', onClick: () => R.go('review') }))));

        if (first) {
            out.push(R.notice(R.command() ? 'warn' : 'bad', 'Before the API can start', h('ul', null, st.reasons.map((r) => h('li', null,
                h('code', { text: r.key }), ' — ' + r.message + ' ',
                h('a', { href: '#', onclick: (e) => { e.preventDefault(); R.fix(r.key); } }, 'Fix this'))))));
        }
        if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
            out.push(R.notice('warn', 'This connection is not encrypted', 'Passwords and secrets you enter here travel in clear text. Use an SSH tunnel (ssh -L) or run the setup locally.'));
        }
        if (st.container) out.push(R.notice('info', 'Running in a container', 'Files written here are lost on redeploy unless ' + st.envFile.path + ' and config/ are on a volume. Review & start also exports the settings for compose or Kubernetes.'));
        if (!st.envFile.writable) out.push(R.notice('warn', st.envFile.display + ' is not writable', 'Set ENV_FILE to a writable path, or copy the export from Review & start into your environment.'));

        const providers = (R.value('AUTH_PROVIDERS') || 'local').split(',').filter(Boolean);
        out.push(h('div', { class: 'grid-4', style: { marginBottom: '18px' } },
            R.stat('database', 'Database', R.hasValue('DATABASE_URL') ? (p.schema.provider || 'set') : 'Not configured', p.schema.exists ? p.schema.path : 'no schema', R.hasValue('DATABASE_URL') ? '' : 'bad-text'),
            R.stat('layers', 'Data model', p.schema.models.length + ' models', p.client.generated ? 'Prisma client generated' : 'Prisma client missing', p.client.generated ? '' : 'warn-text'),
            R.stat('code', 'Generated code', p.generated.routes + ' routes', p.generated.models + ' model classes'),
            R.signInOff() ? R.stat('key', 'Sign-in', 'None', 'every request is anonymous', 'warn-text')
                : R.stat('key', 'Sign-in', providers.join(', '), (R.value('AUTH_STRATEGIES') || 'bearer') + ' tokens')));
        out.push(checklist());
        return out;
    }
    R.page({ id: 'overview', title: 'Overview', group: null, icon: 'home', render: overview,
        enter: () => { if (!S.admin && R.hasValue('DATABASE_URL')) R.api('POST', '/admin/status', R.payload()).then((r) => { S.admin = r; R.refreshChrome(); if (S.page === 'overview') R.render(); }); } });

    // ── Database ─────────────────────────────────────────────────────────
    R.page({
        id: 'database', title: 'Database', group: 'Get started', icon: 'database',
        status: () => {
            const state = R.groupState(['database']);
            const redis = R.sectionState(R.section('redis'));
            return state === 'bad' || redis === 'bad' ? 'bad' : state;
        },
        render: () => [
            R.pageHead('Database', 'The connection the API uses for every query — and an optional Redis for sessions and rate limits across instances.'),
            R.sectionCard(R.section('database'), { title: 'Database connection' }),
            R.sectionCard(R.section('redis'), { title: 'Redis', optional: 'Set up Redis', description: 'Optional. Sessions and rate limits are shared between instances through Redis; without it they live in each instance.' }),
            R.pager(null, 'model'),
        ],
    });

    // ── Sign-in ──────────────────────────────────────────────────────────
    R.page({
        id: 'signin', title: 'Sign-in', group: 'Get started', icon: 'key',
        status: () => R.groupState(AUTH_SECTIONS),
        render: () => {
            const providers = (R.value('AUTH_PROVIDERS') || 'local').split(',').map((x) => x.trim()).filter(Boolean);
            const out = [R.pageHead('Sign-in', 'How users sign in: local accounts, LDAP / Active Directory, OpenID Connect or SAML (Entra ID, ADFS, Keycloak, Okta, …) or WebDAV — and the tokens and sessions they get. Or no sign-in at all.')];
            const noSignIn = R.button('No sign-in', { size: 'sm', icon: 'globe', disabled: R.info('AUTH_PROVIDERS').locked, onClick: () => R.setValue('AUTH_PROVIDERS', 'none', true) });
            if (R.signInOff()) {
                const closed = R.value('ACL_DEFAULT') === 'deny';
                out.push(R.notice(closed ? 'info' : 'warn', 'No sign-in — every request is anonymous',
                    'The API has no sign-in routes and issues no tokens. Every request runs as the anonymous user ({ id: null }): src/config/acl.ts decides what it may read and change. Models without an entry there are '
                        + (closed ? 'closed (ACL_DEFAULT=deny).' : 'open to everyone who reaches the API.'),
                    [R.button('Data model & API', { size: 'sm', icon: 'shield', onClick: () => R.go('model') }),
                        R.info('AUTH_PROVIDERS').locked ? null : R.button('Turn sign-in on', { size: 'sm', kind: 'ghost', onClick: () => R.setValue('AUTH_PROVIDERS', '', true) })]));
            } else if (S.state.project.userModel === null && providers.includes('local') && !R.hasValue('DB_USER_TABLE')) {
                const candidates = S.state.project.userModelCandidates || [];
                out.push(R.notice('info', 'No user table found', candidates.length
                    ? 'Local sign-in needs a table with a password column. ' + candidates.join(' or ') + (candidates.length === 1 ? ' looks like one.' : ' look like one.')
                    : 'Local sign-in needs a table such as user or account with a password column. Without one, sign-in comes from external providers only — set the table under Users, or run the API without sign-in.',
                candidates.map((c) => R.button('Use ' + c, { size: 'sm', kind: 'primary', icon: 'user', onClick: () => R.setValue('DB_USER_TABLE', c, true) })).concat([noSignIn])));
            }
            for (const id of AUTH_SECTIONS) {
                const section = R.section(id);
                if (section && S.visible[id] !== false) out.push(R.sectionCard(section));
            }
            out.push(R.pager('model', 'admin'));
            return out;
        },
    });

    // ── First user ───────────────────────────────────────────────────────
    function loadAdmin() {
        return R.api('POST', '/admin/status', R.payload()).then((r) => {
            S.admin = r;
            if (S.page === 'admin') R.render();
            R.refreshChrome();
        });
    }
    R.page({
        id: 'admin', title: 'First user', group: 'Get started', icon: 'user',
        status: () => (S.admin && !S.admin.available && /already/.test(S.admin.reason || '') ? 'ok' : ''),
        enter: loadAdmin,
        render: () => {
            const out = [R.pageHead('First user', 'The first account of the user table — usually the administrator. Possible only while the table is empty.')];
            const a = S.admin;
            if (!a) return out.concat(R.loading('Looking at the user table…'));
            const result = S.ui.adminResult;
            if (result && result.ok) return out.concat(R.notice('ok', result.message, 'Sign in with it once the API runs.'), R.pager('signin', 'rls'));
            if (!a.available) {
                const use = (a.candidates || []).map((c) => R.button('Use ' + c + ' as the user table', { size: 'sm', kind: 'primary', icon: 'user', onClick: () => { R.setValue('DB_USER_TABLE', c, true); S.admin = null; setTimeout(loadAdmin, 400); } }));
                return out.concat(R.notice(/already/.test(a.reason || '') ? 'ok' : 'warn', a.reason, null, use.concat([R.button('Check again', { size: 'sm', icon: 'refresh', onClick: loadAdmin })])), R.pager('signin', 'rls'));
            }
            const errors = (result && result.errors) || {};
            const fields = a.model.fields.map((f) => {
                const id = 'u-' + f.name;
                const input = f.enumValues
                    ? R.select([['', 'Default' + (f.default ? ' — ' + f.default : '')]].concat(f.enumValues.map((v) => [v, v])), '', () => undefined, { id })
                    : f.type === 'Boolean' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id, checked: f.default === 'true' }), 'Yes')
                        : h('input', { class: 'input', id, type: f.type === 'DateTime' ? 'datetime-local' : 'text', autocomplete: 'off', placeholder: f.default ? 'Default: ' + f.default : '' });
                return h('div', { class: 'field' },
                    h('div', null, h('label', { class: 'name', for: id }, f.name, f.required ? h('span', { class: 'req', text: '*' }) : null), h('span', { class: 'key', text: f.type })),
                    h('div', null, input, errors[f.name] ? h('div', { class: 'msg error' }, R.icon('alert'), errors[f.name]) : null));
            });
            const passwords = ['password', 'password2'].map((id, i) => h('div', { class: 'field' },
                h('div', null, h('label', { class: 'name', for: 'u-' + id }, i ? 'Repeat password' : 'Password', h('span', { class: 'req', text: '*' }))),
                h('div', null, h('input', { class: 'input', type: 'password', id: 'u-' + id, autocomplete: 'new-password' }),
                    !i && errors.password ? h('div', { class: 'msg error' }, R.icon('alert'), errors.password) : null)));
            const submit = async () => {
                const data = {};
                for (const f of a.model.fields) {
                    const el = document.getElementById('u-' + f.name);
                    data[f.name] = el.type === 'checkbox' ? String(el.checked) : el.value;
                }
                data.password = document.getElementById('u-password').value;
                if (data.password !== document.getElementById('u-password2').value) {
                    S.ui.adminResult = { ok: false, message: 'The passwords are not the same', errors: { password: 'Does not match' } };
                    R.render();
                    return;
                }
                S.ui.adminResult = await R.api('POST', '/admin', R.payload({ user: data }));
                if (S.ui.adminResult.ok) {
                    R.toast('ok', S.ui.adminResult.message);
                    S.admin = null;
                    loadAdmin();
                }
                R.render();
            };
            out.push(R.card({ title: 'New account', description: 'Table ' + a.model.model + ' · signs in with ' + a.model.identifierFields.join(' or ') + '. The password is stored as a bcrypt hash.' },
                fields, passwords),
            result && !result.ok ? R.result(result) : null,
            h('div', { class: 'row', style: { marginBottom: '18px' } }, R.button('Create account', { kind: 'primary', icon: 'user', onClick: submit })),
            R.pager('signin', 'rls'));
            return out;
        },
    });

    // ── Accepted values ──────────────────────────────────────────────────
    /**
     * "Accepted values" under a field: rows of [values, meaning]. A value given as { use } fills
     * the field with a click (highlighted while it is the field's value); a string is an example.
     */
    function reference(key, title, rows, foot) {
        const current = (R.value(key) || '').replace(/\s+/g, '');
        const locked = R.info(key).locked;
        const all = rows.flatMap(([values]) => values);
        const clickable = all.some((v) => typeof v !== 'string');
        const note = !clickable ? null : all.some((v) => typeof v === 'string') ? ' · click a value to use it; dashed ones are examples' : ' · click one to use it';
        const value = (v) => typeof v === 'string' ? h('code', { text: v })
            : h('button', { type: 'button', class: 'pick' + (current === v.use.replace(/\s+/g, '') ? ' on' : ''), disabled: locked,
                title: locked ? 'Set in the environment — change it there' : 'Use ' + v.use, onclick: () => R.setValue(key, v.use, true) }, v.use);
        return h('div', { class: 'ref' },
            h('div', { class: 'ref-title' }, title, note ? h('span', { class: 'ref-note', text: note }) : null),
            h('dl', null, rows.map(([values, text]) => [h('dt', null, values.map(value)), h('dd', null, text)])),
            foot ? h('div', { class: 'foot' }, foot) : null);
    }
    const use = (v) => ({ use: v });

    // ── Trusted proxies ──────────────────────────────────────────────────
    R.fieldDocs.TRUST_PROXY = () => reference('TRUST_PROXY', 'Accepted values — combine them with commas', [
        [[use('private')], 'Proxies on this machine or in your private network — nginx, Docker, Kubernetes (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7).'],
        [[use('cloudflare')], 'Cloudflare’s servers — its published address ranges.'],
        [[use('private,cloudflare')], 'Cloudflare in front of a proxy on this machine: the usual Cloudflare setup.'],
        [['10.0.0.0/8', '203.0.113.7'], 'Proxies at these addresses: IPs or CIDR ranges, IPv4 or IPv6.'],
        [[use('1'), '2'], h('span', null, 'That many proxies in a row, each at a private address. ', h('code', { text: '1,203.0.113.0/24' }), ': one proxy, at those addresses.')],
        [[use('true')], 'Every proxy: any client can claim any IP. Fine in development, risky in production.'],
        [[use('false')], 'No proxy: the API sees the proxy’s address instead of the client’s.'],
    ], 'Empty: every proxy (production logs a warning). loopback, linklocal and uniquelocal — the parts of private — work on their own too.');

    // ── Database connection ──────────────────────────────────────────────
    R.fieldDocs.DATABASE_URL = () => {
        const url = R.value('DATABASE_URL') || '';
        const provider = /^(mysql|mariadb):/.test(url) ? 'mysql' : /^postgres(ql)?:/.test(url) ? 'postgresql' : S.state.project && S.state.project.schema.provider;
        const rows = [
            [['postgresql://user:password@host:5432/app'], 'PostgreSQL (postgres:// works too).'],
            [['mysql://user:password@host:3306/app'], 'MySQL and MariaDB (mariadb:// works too).'],
            [['%40', '%3A', '%2F', '%23'], 'Special characters in the user or password are URL-encoded: @ → %40, : → %3A, / → %2F, # → %23, ? → %3F, % → %25.'],
        ];
        const postgres = [
            [['schema=store'], 'PostgreSQL: the schema the API works in (default public).'],
            [['connection_limit=20'], 'Connections in the pool (default 10).'],
            [['pool_timeout=10'], 'Seconds to wait for a free connection.'],
            [['sslmode=require'], h('span', null, 'TLS, certificate checked — your own CA with ', h('code', { text: 'sslrootcert=/path/ca.pem' }), '; ', h('code', { text: 'sslmode=no-verify' }), ' skips the check.')],
        ];
        const mysql = [
            [['connection_limit=20'], 'MySQL / MariaDB: connections in the pool (default 10).'],
            [['connect_timeout=5', 'socket_timeout=30'], 'Seconds to connect · per query.'],
            [['sslaccept=strict'], h('span', null, 'TLS, certificate checked (', h('code', { text: 'accept_invalid_certs' }), ': not checked); ', h('code', { text: 'ssl=true' }), ' turns TLS on too.')],
            [['sslcert=ca.pem'], 'The CA file, relative to prisma/.'],
            [['socket=/run/mysqld/mysqld.sock'], 'Connect through a Unix socket.'],
            [['allowPublicKeyRetrieval=false'], 'MySQL 8 without TLS needs the server’s key — fetched unless this says false.'],
        ];
        const params = provider === 'mysql' ? mysql : provider === 'postgresql' ? postgres : postgres.concat(mysql);
        return reference('DATABASE_URL', 'Format and parameters', rows.concat(params), 'Parameters follow a ?, joined with &: …/app?schema=store&connection_limit=20.');
    };

    // ── Identities ───────────────────────────────────────────────────────
    R.fieldDocs.AUTH_LINK = () => reference('AUTH_LINK', 'Accepted values', [
        [[use('email')], 'The row whose email column equals the identity’s email (case-insensitive on PostgreSQL). The default.'],
        [[use('username')], 'Its username column equals the sign-in name at the directory or identity provider.'],
        [[use('subject')], 'Its subject column equals the identity’s stable id — OIDC sub (OIDC_SUBJECT_CLAIM), LDAP entryUUID or objectGUID.'],
        [['employee_no:employeeNumber'], 'Any pair, user column : identity attribute — the attribute is email, username, subject, name, or any claim or LDAP attribute.'],
        [[use('false')], 'No user-table rows: users are the identity’s claims — id, email, name, groups and roles.'],
    ], 'No matching row: the sign-in is rejected — unless provision in src/config/auth.ts creates one.');

    // ── User table ───────────────────────────────────────────────────────
    R.fieldDocs.DB_USER_TABLE = () => {
        const models = (S.state.project && S.state.project.schema.models) || [];
        if (!models.length) return h('div', { class: 'help', text: 'No models yet — read them from the database under Data model & API.' });
        const candidates = S.state.project.userModelCandidates || [];
        const shown = models.slice(0, 40);
        return reference('DB_USER_TABLE', 'Models in prisma/schema.prisma', [
            [shown.map(use), candidates.length ? (candidates.join(', ') + (candidates.length === 1 ? ' looks' : ' look') + ' like a user table: a password column and a unique text column.') : 'A user table has a password column and a unique text column (email, username).'],
        ], models.length > shown.length ? '… and ' + (models.length - shown.length) + ' more — type the name.' : null);
    };

    R.fieldHints.TRUST_PROXY = () => {
        const p = S.proxy;
        if (!p) return null;
        const out = [];
        // What is wrong is the field's warning (the review lists it too) — here: the way in, and the fix
        const fix = p.proposal && R.value('TRUST_PROXY') !== p.proposal;
        if (p.chain.length > 1) {
            const route = p.chain.slice().reverse().map((hop, i) => (i === 0 ? 'you ' + hop.address : hop.kind + ' ' + hop.address)).concat(['API']).join(' → ');
            out.push(h('div', { class: 'help', text: 'This page came in: ' + route + (p.seenAs && !fix ? '. With this setting the API takes you for ' + p.seenAs + '.' : '.') }));
        }
        if (fix) {
            out.push(h('div', { class: 'row', style: { marginTop: '8px' } }, R.info('TRUST_PROXY').locked
                ? h('span', { class: 'muted small', text: 'Set in the environment — change it there.' })
                : R.button('Use ' + p.proposal, { size: 'sm', kind: 'primary', icon: 'check', onClick: () => R.setValue('TRUST_PROXY', p.proposal, true) })));
        }
        if (p.replacedForwardedFor) {
            out.push(h('div', { style: { marginTop: '8px' } }, R.notice('warn', 'The visitor’s address is lost on this machine',
                h('span', null, 'The proxy in front of the API replaces X-Forwarded-For with Cloudflare’s address instead of adding to it. nginx: ',
                    h('code', { text: 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' })))));
        }
        return out;
    };

    // ── SAML ─────────────────────────────────────────────────────────────
    /** The identity provider and this API's values — asked again when something they depend on changes */
    function samlInfo() {
        const text = R.fileText('samlIdp') || '';
        const key = ['SAML_IDP_METADATA_URL', 'SAML_IDP_METADATA_FILE', 'SAML_IDP_ENTITY_ID', 'PUBLIC_URL', 'SAML_SP_ENTITY_ID', 'SAML_CALLBACK_URL']
            .map((k) => R.value(k) || '').concat([String(text.length), text.slice(0, 80), text.slice(-80)]).join('|');
        if (S.ui.samlKey !== key) {
            S.ui.samlKey = key;
            S.ui.saml = null;
            R.api('POST', '/saml/idp', R.payload()).then((r) => {
                if (S.ui.samlKey !== key) return;
                S.ui.saml = r && r.__status < 400 ? r : { error: (r && r.error) || 'The metadata could not be read' };
                R.updateMessages();
            });
        }
        return S.ui.saml;
    }

    function samlBox(title, rows, foot) {
        return h('div', { class: 'ref' }, h('div', { class: 'ref-title', text: title }),
            h('dl', null, rows.map(([label, value]) => [h('dt', null, label), h('dd', null, value)])),
            foot ? h('div', { class: 'foot' }, foot) : null);
    }

    /** Upload of the identity provider's metadata, and what it says */
    R.fieldHints.SAML_IDP_METADATA_FILE = () => {
        const info = samlInfo();
        const out = [];
        const problems = (S.fileProblems && S.fileProblems.samlIdp) || [];
        if (problems.length) out.push(R.notice('bad', 'The uploaded file', problems.join(' · ')));
        else if (info && info.error) out.push(R.notice('bad', 'The metadata', info.error));
        else if (info && info.idp) {
            const idp = info.idp;
            const from = { url: 'the metadata URL', upload: 'the upload — saved with the setup', file: info.metadataFile }[idp.source];
            out.push(samlBox('Identity provider', [
                ['Entity id', h('code', { text: idp.entityId })],
                ['Single sign-on', idp.ssoUrl ? h('code', { text: idp.ssoUrl }) : h('span', { class: 'bad-text', text: 'no HTTP-Redirect endpoint — sign-in cannot start' })],
                ['Certificates', h('div', null, idp.certificates.map((c) => h('div', null, c.subject + ' · until ' + c.validTo.slice(0, 10) + ' ',
                    c.expired ? R.badge('expired', 'bad') : c.expiresSoon ? R.badge('expires soon', 'warn') : R.badge('valid', 'ok'))))],
                idp.wantAuthnRequestsSigned && !R.value('SAML_SP_PRIVATE_KEY_FILE')
                    ? ['Requests', h('span', { class: 'warn-text', text: 'it asks for signed ones — set a private key and certificate (advanced), or turn that off for this API at the identity provider' })] : null,
            ].filter(Boolean), 'From ' + from + '.'));
        }
        if (!info || info.uploads) {
            const input = h('input', { type: 'file', accept: '.xml,application/xml,text/xml,application/samlmetadata+xml', style: { display: 'none' },
                onchange: (e) => {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    file.text().then((xml) => {
                        R.setFileText('samlIdp', xml);
                        R.toast('ok', file.name + ' — saved with the setup');
                    });
                } });
            out.push(h('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } },
                R.button(R.fileDirty('samlIdp') || (info && info.idp && info.idp.source === 'file') ? 'Replace metadata file' : 'Upload metadata file', { size: 'sm', icon: 'file', onClick: () => input.click() }),
                R.fileDirty('samlIdp') ? R.button('Discard upload', { size: 'sm', kind: 'ghost', onClick: () => R.discardFile('samlIdp') }) : null,
                input));
        } else if (info && !R.value('SAML_IDP_METADATA_URL')) {
            out.push(h('div', { class: 'help', text: 'An upload is saved to config/saml-idp-metadata.xml — clear this setting to use one.' }));
        }
        return out;
    };

    /** What the identity provider needs to know about this API — and this API's metadata to upload there */
    R.fieldHints.SAML_SP_ENTITY_ID = () => {
        const info = samlInfo();
        const service = info && info.service;
        if (!service) return null;
        const copyable = (value) => h('span', { class: 'row', style: { gap: '6px' } }, h('code', { text: value }), R.copyButton(value, 'Copy'));
        return samlBox('Register this API at the identity provider', [
            ['Entity id', copyable(service.entityId)],
            ['Assertion consumer URL', copyable(service.acsUrl)],
            ['Metadata', h('span', { class: 'row', style: { gap: '6px' } }, h('code', { text: service.metadataUrl }),
                R.button('Download', { size: 'sm', icon: 'download', onClick: async () => {
                    const r = await R.api('POST', '/saml/metadata', R.payload());
                    if (r.__status >= 400) return R.toast('bad', r.error || 'The metadata could not be made');
                    const link = h('a', { href: URL.createObjectURL(new Blob([r.xml], { type: 'application/samlmetadata+xml' })), download: 'rapidd-sp-metadata.xml' });
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                } }))],
        ], 'Entra ID calls the entity id Identifier and the assertion consumer URL Reply URL. An identity provider that reads metadata takes the URL or the download.');
    };

    // ── Environment ──────────────────────────────────────────────────────
    R.page({
        id: 'environment', title: 'Environment', group: 'Configuration', icon: 'sliders',
        status: () => {
            for (const s of S.state.sections) if (R.sectionState(s) === 'bad') return 'bad';
            return '';
        },
        render: () => {
            const q = (S.ui.envSearch || '').trim().toLowerCase();
            const groups = [];
            for (const s of S.state.sections) if (!groups.includes(s.group)) groups.push(s.group);
            const tab = S.ui.envTab && (S.ui.envTab === 'all' || groups.includes(S.ui.envTab)) ? S.ui.envTab : 'all';
            const onlyChanged = !!S.ui.envChanged;
            const matches = (s) => (!q || (s.key + ' ' + s.label + ' ' + (s.help || '')).toLowerCase().includes(q)) && (!onlyChanged || R.changed(s.key));
            const v = S.validation;
            const cards = [];
            for (const section of S.state.sections) {
                if (S.visible[section.id] === false) continue;
                if (tab !== 'all' && section.group !== tab && !q) continue;
                const settings = section.settings.filter((s) => (!v || v.visible.includes(s.key)) && matches(s));
                if (!settings.length) continue;
                if (!q && !onlyChanged) {
                    cards.push(R.sectionCard(section, { description: h('span', null, R.badge(section.group, 'outline'), ' ', section.description) }));
                } else {
                    cards.push(R.card({ title: section.title, description: h('span', null, R.badge(section.group, 'outline'), ' ', section.description) }, settings.map(R.field)));
                }
            }
            const counts = {};
            for (const s of S.state.sections) if (S.visible[s.id] !== false) counts[s.group] = (counts[s.group] || 0) + s.settings.filter((x) => !v || v.visible.includes(x.key)).length;
            return [
                R.pageHead('Environment', 'Every setting of ' + S.state.envFile.display + ' — the guided pages show the same values. Settings from the real environment are read-only here.'),
                h('div', { class: 'toolbar' },
                    R.search(S.ui.envSearch, (value) => { S.ui.envSearch = value; R.render(); }, 'Search settings, e.g. CORS or JWT', 'env-search'),
                    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: onlyChanged, onchange: (e) => { S.ui.envChanged = e.target.checked; R.render(); } }), 'Changed only')),
                q ? null : h('div', { class: 'tabs', role: 'tablist' },
                    [['all', 'All']].concat(groups.map((g) => [g, g])).map(([id, label]) => h('button', { role: 'tab', class: tab === id ? 'on' : '', 'aria-selected': String(tab === id),
                        onclick: () => { S.ui.envTab = id; R.render(); } }, label, id !== 'all' ? h('span', { class: 'n', text: String(counts[id] || 0) }) : null))),
                cards.length ? cards : R.card({}, R.empty('search', 'No setting matches', q ? 'Nothing found for “' + q + '”.' : 'No changed settings.')),
            ];
        },
    });
}

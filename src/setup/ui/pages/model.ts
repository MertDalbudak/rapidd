// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Data model & API: the Prisma schema, the database tables, and the code generated from them */
export function installModelPage(R) {
    const h = R.h;
    const S = R.S;
    const ACTIONS = [
        ['pull', 'Read from the database', 'prisma db pull — the database’s tables become the schema’s models. Only while the schema has none.', 'download'],
        ['push', 'Create tables', 'prisma db push — the schema’s models become tables. Only into a database that has none of them.', 'database'],
        ['migrate', 'Apply migrations', 'prisma migrate deploy — runs the migrations in prisma/migrations.', 'play'],
        ['generate', 'Generate Prisma client', 'prisma generate — the typed client the API queries with.', 'refresh'],
    ];

    R.loadProject = () => R.api('POST', '/project', R.payload()).then((r) => {
        if (r.__status >= 400) throw new Error(r.error || 'The project could not be read');
        S.project = r;
        // Preselected: the models without code — again whenever the schema's models change
        const names = r.models.map((m) => m.name).join(',');
        if (S.ui.selectionFor !== names) {
            S.ui.selectionFor = names;
            S.ui.selected = r.models.filter((m) => !m.modelFile.exists || (m.route.kind === 'route' && !m.route.exists)).map((m) => m.name);
        }
        if (['model', 'ratelimits', 'access', 'rls'].includes(S.page)) R.render();
        R.refreshChrome();
        return r;
    });

    R.defaultRules = (model) => Object.assign(
        { create: { '*': true }, read: { '*': 'all' }, update: { '*': 'all' }, delete: { '*': 'all' } },
        model.sensitive.length ? { hide: { '*': model.sensitive.slice() } } : {});

    /** Default rules (staged) for the given models that have none — returns how many */
    R.addDefaultRules = (names, models) => {
        const rules = R.fileJson('acl', { models: {} });
        if (rules === null) {
            R.toast('bad', 'config/acl.json is not valid JSON — fix it under Access control first');
            return 0;
        }
        rules.models = rules.models || {};
        let added = 0;
        for (const name of names) {
            const model = models.find((m) => m.name === name);
            if (!model || model.code || rules.models[name]) continue;
            rules.models[name] = R.defaultRules(model);
            added++;
        }
        if (added) R.setFileJson('acl', rules);
        return added;
    };

    async function run(name, build) {
        S.ui.running = name;
        S.ui.output = null;
        R.render();
        try {
            const r = await R.api('POST', '/action/' + name, R.payload(build ? { build } : {}));
            S.ui.output = { name, result: r };
            R.toast(r.ok ? 'ok' : 'bad', r.message);
        } finally {
            S.ui.running = null;
        }
        await R.reload();
        await R.loadProject();
    }

    async function generate(models) {
        const selected = S.ui.selected.filter((n) => models.some((m) => m.name === n));
        const components = ['model', 'route'].filter((c) => S.ui.components[c]);
        // Afterwards the selection starts over with the models that still have no code
        S.ui.selectionFor = null;
        if (components.length) await run('build', { models: selected, components });
        if (S.ui.components.acl) {
            const added = R.addDefaultRules(selected, S.project.models);
            if (added) R.toast('info', 'Default access rules for ' + added + ' model' + (added === 1 ? '' : 's') + ' — review them under Access control, then save.', 8000);
        }
        R.render();
    }

    function access(model) {
        if (model.code) return R.badge('Code', 'brand', 'code');
        const rules = R.fileJson('acl', { models: {} });
        if (rules && rules.models && rules.models[model.name]) return R.badge('Rules', 'ok', 'shield');
        return R.badge(R.value('ACL_DEFAULT') === 'deny' ? 'None — denied' : 'None — open', 'warn', 'alert');
    }

    function route(model) {
        if (model.route.kind === 'nested') return h('span', { class: 'muted', title: 'A join table: its rows are reached through the routes of ' + model.route.parents.join(' and ') }, 'Nested under ' + model.route.parents.join(', '));
        if (model.route.kind === 'none') return h('span', { class: 'faint', title: model.route.reason, text: '— no route' });
        return h('div', null, h('code', { text: model.route.url }), ' ', model.route.exists ? R.icon('check', 'ok-text') : R.badge('missing', 'warn'));
    }

    function schemaCard() {
        const p = S.project.project;
        const actions = S.project.actions;
        return R.card({
            title: 'Schema', icon: 'file',
            description: 'prisma/schema.prisma — ' + (p.schema.exists ? (p.schema.provider || 'unknown provider') + ', ' + p.schema.models.length + ' models' : 'missing'),
            actions: [p.client.generated ? R.badge('Client generated', 'ok', 'check') : R.badge('Client not generated', 'warn', 'alert'), p.migrations ? R.badge('Migrations', 'outline') : null],
            body: 'flush',
        },
        p.schema.error ? h('div', { style: { padding: '14px 20px 0' } }, R.notice('bad', 'The schema has errors', h('pre', { class: 'code light', style: { marginTop: '8px' }, text: p.schema.error }))) : null,
        h('ul', { class: 'checklist' }, ACTIONS.map(([name, title, text, icon]) => {
            const blocker = actions[name];
            return h('li', null,
                h('span', { class: 'mark' }, R.icon(icon)),
                h('div', { class: 'text' }, h('b', { text: title }), h('div', { text: blocker ? text + ' ' : text }, blocker ? h('span', { class: 'warn-text', text: '· ' + blocker }) : null)),
                R.button(S.ui.running === name ? 'Running…' : 'Run', { size: 'sm', icon: S.ui.running === name ? null : 'play', disabled: !!blocker || !!S.ui.running, busy: 'Running…', onClick: () => run(name) }));
        })));
    }

    function modelsCard() {
        const models = S.project.models;
        const build = S.project.build;
        const q = (S.ui.modelSearch || '').toLowerCase();
        const shown = models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.table.toLowerCase().includes(q));
        const selected = new Set(S.ui.selected);
        const toggle = (name, on) => {
            if (on) selected.add(name); else selected.delete(name);
            S.ui.selected = [...selected];
            R.render();
        };
        const allOn = shown.length > 0 && shown.every((m) => selected.has(m.name));
        const chosen = models.filter((m) => selected.has(m.name)).length;
        const components = S.ui.components;
        const chip = (id, label) => h('button', { type: 'button', class: 'chip' + (components[id] ? ' on' : ''), 'aria-pressed': String(!!components[id]),
            onclick: () => { components[id] = !components[id]; R.render(); } }, components[id] ? R.icon('check') : null, label);
        const nothing = !components.model && !components.route && !components.acl;
        return R.card({
            title: 'Models & routes', icon: 'layers',
            description: 'Generated code: a model class (src/models) and a REST route (routes/api/v1) per model. Existing files are never overwritten.',
            body: 'flush',
            footer: [
                h('span', { class: 'muted small', text: 'Generate' }),
                chip('model', 'Model classes'), chip('route', 'REST routes'), chip('acl', 'Default access rules'),
                h('span', { style: { flex: 1 } }),
                R.button('Generate for ' + chosen + ' model' + (chosen === 1 ? '' : 's'), {
                    kind: 'primary', icon: 'play', busy: 'Generating…',
                    disabled: !chosen || nothing || !!S.ui.running || (!!S.project.actions.build && (components.model || components.route)),
                    title: S.project.actions.build || null,
                    onClick: () => generate(models),
                }),
            ],
        },
        !build.installed ? h('div', { style: { padding: '14px 20px 0' } }, R.notice('warn', '@rapidd/build is not installed', h('span', null, 'Install the code generator: ', h('code', { text: 'npm install -D @rapidd/build' })))) : null,
        h('div', { class: 'toolbar', style: { padding: '14px 20px 0' } },
            R.search(S.ui.modelSearch, (v) => { S.ui.modelSearch = v; R.render(); }, 'Filter models', 'model-search'),
            R.button('Select models without code', { size: 'sm', kind: 'ghost', onClick: () => {
                S.ui.selected = models.filter((m) => !m.modelFile.exists || (m.route.kind === 'route' && !m.route.exists)).map((m) => m.name);
                R.render();
            } })),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null,
                h('th', { class: 'shrink' }, h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: allOn, onchange: (e) => {
                    for (const m of shown) if (e.target.checked) selected.add(m.name); else selected.delete(m.name);
                    S.ui.selected = [...selected];
                    R.render();
                } })),
                h('th', { text: 'Model' }), h('th', { text: 'Key' }), h('th', { text: 'Model class' }), h('th', { text: 'REST route' }), h('th', { text: 'Access' }))),
            h('tbody', null, shown.map((m) => h('tr', { class: selected.has(m.name) ? 'selected' : '' },
                h('td', { class: 'shrink' }, h('input', { type: 'checkbox', 'aria-label': 'Select ' + m.name, checked: selected.has(m.name), onchange: (e) => toggle(m.name, e.target.checked) })),
                h('td', null, h('b', { text: m.name }), m.table !== m.name ? h('div', { class: 'sub', text: 'table ' + m.table }) : null, h('div', { class: 'sub', text: m.fields.length + ' fields' })),
                h('td', null, h('code', { text: m.key.join(', ') || '—' })),
                h('td', null, m.modelFile.exists ? h('span', { title: m.modelFile.path }, R.icon('check', 'ok-text'), ' ', h('code', { text: m.modelFile.path.replace(/^src\/models\//, '') })) : R.badge('missing', 'warn')),
                h('td', null, route(m)),
                h('td', null, h('a', { href: '#/access/' + encodeURIComponent(m.name), onclick: (e) => { e.preventDefault(); S.ui.aclModel = m.name; R.go('access', m.name); } }, access(m)))))))),
        shown.length === 0 ? R.empty('layers', 'No models match', 'Clear the filter to see every model.') : null,
        build.installed && !build.modelList && chosen > 1 && chosen < models.length
            ? h('div', { class: 'muted small', style: { padding: '10px 20px' }, text: 'This version of @rapidd/build generates one model per run — several models take a little longer.' }) : null);
    }

    R.page({
        id: 'model', title: 'Data model & API', group: 'Get started', icon: 'layers',
        status: () => {
            const p = S.state.project;
            if (!p.schema.exists || p.schema.error || S.state.reasons.some((r) => r.key === 'prisma/client')) return 'bad';
            if (p.schema.models.length === 0) return '';
            return p.generated.routes > 0 ? 'ok' : 'warn';
        },
        enter: () => { R.loadProject().catch((err) => R.toast('bad', err.message)); },
        render: () => {
            if (!S.ui.components) S.ui.components = { model: true, route: true, acl: true };
            const head = R.pageHead('Data model & API', 'Your database becomes the API: the Prisma schema describes the tables, @rapidd/build generates a model class and a REST route for each.',
                [R.button('Refresh', { icon: 'refresh', onClick: () => R.loadProject() })]);
            if (!S.project) return [head, R.loading('Reading the schema…')];
            const p = S.project.project;
            const out = [head, schemaCard()];
            if (p.schema.models.length === 0) {
                out.push(R.card({ title: 'Models & routes', icon: 'layers' }, R.empty('layers', 'No models yet',
                    'Read them from an existing database above — or write models into prisma/schema.prisma and create their tables.')));
            } else {
                out.push(modelsCard());
            }
            if (S.ui.output) out.push(R.console(S.ui.output.name === 'build' ? 'rapidd build' : 'prisma ' + S.ui.output.name, S.ui.output.result.output, S.ui.output.result.ok));
            out.push(R.pager('database', 'signin'));
            return out;
        },
    });
}

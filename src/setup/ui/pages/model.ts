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
        // MariaDB keeps JSON in LONGTEXT — columns the schema reads as String (asks the database)
        if (S.page === 'model' && r.project.schema.provider === 'mysql' && r.models.length) {
            R.api('POST', '/schema/json', R.payload()).then((j) => {
                const next = j && j.__status < 400 && j.fields && j.fields.length ? j : null;
                if (String(next && next.fields) === String(S.ui.json && S.ui.json.fields)) return;
                S.ui.json = next;
                if (S.page === 'model') R.render();
            });
        } else {
            S.ui.json = null;
        }
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

    // ── Relation names ───────────────────────────────────────────────────
    const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

    /** Rename relation fields: read from a database they are named after the related table, and the API uses them */
    function renameRelations(models) {
        const names = {};
        for (const m of models) {
            names[m.name] = {};
            for (const r of m.relationFields) names[m.name][r.name] = r.name;
        }
        let error = '';
        const problem = (m, r) => {
            const v = names[m.name][r.name];
            if (!NAME.test(v)) return 'Letters, digits and _, starting with a letter';
            const others = m.fields.map((f) => f.name).concat(m.relationFields.filter((o) => o !== r).map((o) => names[m.name][o.name]));
            return others.includes(v) ? m.name + ' has another field named ' + v : '';
        };
        const changes = () => {
            const out = {};
            for (const m of models) for (const r of m.relationFields) {
                if (names[m.name][r.name] !== r.name) (out[m.name] = out[m.name] || {})[r.name] = names[m.name][r.name];
            }
            return out;
        };
        const open = () => models.flatMap((m) => m.relationFields.filter((r) => r.suggestion && names[m.name][r.name] !== r.suggestion).map((r) => [m, r]));
        const describe = (r) => (r.list ? 'rows of ' : 'one row of ') + r.target + (r.foreignKey.length ? ' · by ' + (r.owner ? '' : r.target + '.') + r.foreignKey.join(', ') : '');
        const d = R.dialog({
            title: models.length === 1 ? 'Relations of ' + models[0].name : 'Relation names', wide: true,
            render: () => {
                const renames = changes();
                const count = Object.values(renames).reduce((n, c) => n + Object.keys(c).length, 0);
                const invalid = models.some((m) => m.relationFields.some((r) => problem(m, r)));
                return {
                    body: [
                        h('p', { class: 'muted', style: { marginTop: 0 }, text: 'These names are the API’s — in include=, fields= and filters. Read from a database, a relation is named after the related table; rename it to what it means. The database does not change, but requests and code that use an old name have to.' }),
                        models.map((m) => h('div', { style: { marginTop: '12px' } },
                            models.length > 1 ? h('b', { text: m.name }) : null,
                            h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', null, m.relationFields.map((r) => {
                                const p = problem(m, r);
                                const value = names[m.name][r.name];
                                return h('tr', null,
                                    h('td', { class: 'shrink' }, h('code', { text: r.name })),
                                    h('td', null,
                                        h('input', { class: 'input' + (p ? ' invalid' : ''), id: 'rel-' + m.name + '-' + r.name, value, spellcheck: 'false', 'aria-label': 'Name for ' + r.name,
                                            oninput: (e) => { names[m.name][r.name] = e.target.value.trim(); d.update(); } }),
                                        p ? h('div', { class: 'bad-text small', text: p }) : null),
                                    h('td', { class: 'muted small', text: describe(r) }),
                                    h('td', { class: 'shrink' }, r.suggestion && value !== r.suggestion
                                        ? R.button(r.suggestion, { size: 'sm', kind: 'ghost', icon: 'edit', title: 'Use the suggested name', onClick: () => { names[m.name][r.name] = r.suggestion; d.update(); } })
                                        : null));
                            })))))),
                        error ? R.notice('bad', 'Not renamed', h('pre', { class: 'code light', style: { marginTop: '8px' }, text: error })) : null,
                    ],
                    actions: [
                        h('div', { class: 'left' }, R.button('Use all suggestions', { kind: 'ghost', size: 'sm', disabled: open().length === 0, onClick: () => {
                            for (const [m, r] of open()) names[m.name][r.name] = r.suggestion;
                            d.update();
                        } })),
                        R.button('Cancel', { onClick: () => d.close() }),
                        R.button(count ? 'Rename ' + count : 'Rename', { kind: 'primary', busy: 'Renaming…', disabled: !count || invalid || !!S.ui.running, onClick: async () => {
                            const acl = R.fileJson('acl', null);
                            const r = await R.api('POST', '/schema/relations', R.payload({ renames, acl }));
                            if (r.__status >= 400) {
                                error = r.error || 'The schema could not be changed';
                                d.update();
                                return;
                            }
                            let note = '';
                            if (r.acl && JSON.stringify(r.acl) !== JSON.stringify(acl)) {
                                R.setFileJson('acl', r.acl);
                                note = ' The access rules that use them are updated — save them under Review & start.';
                            }
                            R.toast(r.ok ? 'ok' : 'bad', r.message + note, note ? 8000 : undefined);
                            S.ui.output = { name: 'generate', result: r };
                            d.close();
                            await R.loadProject();
                        } }),
                    ],
                };
            },
        });
    }

    function relationsLink(m) {
        const n = m.relationFields.length;
        if (!n) return null;
        const suggested = m.relationFields.some((r) => r.suggestion);
        return [' · ', h('a', { href: '#', title: suggested ? 'Rename relations — clearer names are suggested' : 'Rename relations',
            onclick: (e) => { e.preventDefault(); renameRelations([m]); } }, n + ' relation' + (n === 1 ? '' : 's'))];
    }

    async function typeJson() {
        const r = await R.api('POST', '/schema/json', R.payload({ apply: true }));
        if (r.__status >= 400) {
            R.toast('bad', r.error || 'The schema could not be changed');
            return;
        }
        R.toast(r.ok ? 'ok' : 'bad', r.message);
        S.ui.output = { name: 'generate', result: r };
        S.ui.json = null;
        await R.loadProject();
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
        const suggested = models.filter((m) => m.relationFields.some((r) => r.suggestion));
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
        S.ui.json ? h('div', { style: { padding: '14px 20px 0' } }, R.notice('warn', 'JSON read as text',
            h('span', null, 'MariaDB keeps JSON in LONGTEXT columns, which Prisma reads as String — the API returns ', h('code', { text: S.ui.json.fields.join(', ') }), ' as text instead of JSON.'),
            [R.button('Type as Json', { size: 'sm', kind: 'primary', busy: 'Typing…', disabled: !!S.ui.running, onClick: typeJson })])) : null,
        h('div', { class: 'toolbar', style: { padding: '14px 20px 0' } },
            R.search(S.ui.modelSearch, (v) => { S.ui.modelSearch = v; R.render(); }, 'Filter models', 'model-search'),
            R.button('Select models without code', { size: 'sm', kind: 'ghost', onClick: () => {
                S.ui.selected = models.filter((m) => !m.modelFile.exists || (m.route.kind === 'route' && !m.route.exists)).map((m) => m.name);
                R.render();
            } }),
            suggested.length ? R.button('Relation names', { size: 'sm', kind: 'ghost', icon: 'edit', title: 'Clearer names for relations read from the database', onClick: () => renameRelations(suggested) }) : null),
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
                h('td', null, h('b', { text: m.name }), m.table !== m.name ? h('div', { class: 'sub', text: 'table ' + m.table }) : null, h('div', { class: 'sub' }, m.fields.length + ' fields', relationsLink(m))),
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

// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Row-level security: the variables the API sets (config/rls.json) and the policies of PostgreSQL */
export function installRlsPage(R) {
    const h = R.h;
    const S = R.S;
    const PRESETS = [
        ['current_user_id', 'user.id', 'User id'],
    ];
    const COMMANDS = [['ALL', 'All'], ['SELECT', 'Read'], ['INSERT', 'Create'], ['UPDATE', 'Update'], ['DELETE', 'Delete']];

    function load() {
        S.ui.rlsLoading = true;
        return R.api('POST', '/rls', R.payload()).then((r) => {
            S.rls = r;
            S.ui.rlsLoading = false;
            if (S.page === 'rls') R.render();
            R.refreshChrome();
        });
    }

    function variables() {
        const rules = R.fileJson('rls', { variables: {} });
        if (rules && (!rules.variables || typeof rules.variables !== 'object')) rules.variables = {};
        return rules;
    }
    function setVariables(vars) {
        const rules = variables() || {};
        rules.variables = vars;
        R.setFileJson('rls', rules);
        R.render();
    }
    const namespace = () => R.value('RLS_NAMESPACE') || 'app';

    // ── Database changes ─────────────────────────────────────────────────
    async function apply(operation, title, text, danger) {
        const preview = await R.api('POST', '/rls/sql', R.payload({ operation }));
        if (preview.__status >= 400) return R.toast('bad', preview.error);
        const ok = await R.confirm({
            title, text, danger, confirm: 'Apply to the database',
            body: h('pre', { class: 'code', style: { marginTop: '12px' }, text: preview.statements.join('\n\n') }),
        });
        if (!ok) return;
        const r = await R.api('POST', '/rls/apply', R.payload({ operation }));
        if (r.__status >= 400 || !r.ok) R.toast('bad', r.error || r.message);
        else R.toast('ok', r.message);
        await load();
    }

    function policyDialog(table, model) {
        const vars = Object.keys((variables() || {}).variables || {});
        const fields = model.fields.filter((f) => !f.isList);
        const guess = fields.find((f) => /tenant|owner|user_?id|author|account/i.test(f.name)) || fields[0];
        const role = S.rls.connection;
        const spec = {
            model: model.name, name: '', command: 'ALL', combine: 'AND',
            match: [{ field: guess ? guess.name : '', variable: vars.find((v) => /tenant/.test(v) && /tenant/i.test(guess ? guess.name : '')) || vars[0] || 'current_user_id' }],
            bypass: null, enable: true, force: !!(role && table.owner === role.user && !table.forced),
        };
        let sql = '';
        let error = '';
        let timer = null;
        const refresh = () => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
                const r = await R.api('POST', '/rls/sql', R.payload({ operation: { op: 'create', policy: spec } }));
                if (r.__status >= 400) { error = r.error; sql = ''; } else { error = ''; sql = r.statements.join('\n\n'); }
                d.update();
            }, 200);
        };
        const unknown = () => spec.match.map((m) => m.variable).concat(spec.bypass ? [spec.bypass.variable] : []).filter((v) => v && !vars.includes(v));
        const varInput = (value, onInput, id) => h('span', { class: 'with-addon', style: { flex: 1, minWidth: '220px' } },
            h('span', { class: 'addon mono', text: namespace() + '.' }),
            h('input', { class: 'input mono', id, list: 'rls-vars', value, placeholder: 'variable', oninput: (e) => { onInput(e.target.value.trim()); refresh(); } }));
        const d = R.dialog({
            title: 'New policy on ' + table.table, wide: true,
            render: () => ({
                body: [
                    h('datalist', { id: 'rls-vars' }, vars.map((v) => h('option', { value: v }))),
                    h('div', { class: 'form-row' }, h('label', { text: 'Applies to' }),
                        R.seg(COMMANDS, spec.command, (v) => { spec.command = v; d.update(); refresh(); }, { label: 'Command' }),
                        h('div', { class: 'help', text: spec.command === 'INSERT' ? 'New rows must match (WITH CHECK).' : spec.command === 'SELECT' || spec.command === 'DELETE' ? 'Only matching rows are visible (USING).' : 'Only matching rows are visible, and rows written must match too.' })),
                    h('div', { class: 'form-row' }, h('label', { text: 'Rows where' }),
                        h('div', { class: 'stack' }, spec.match.map((m, i) => h('div', { class: 'row' },
                            R.select(fields.map((f) => [f.name, f.name + ' · ' + f.type]), m.field, (v) => { m.field = v; refresh(); }, { id: 'p-field-' + i, label: 'Column' }),
                            h('span', { class: 'muted', text: 'equals' }),
                            varInput(m.variable, (v) => { m.variable = v; }, 'p-var-' + i),
                            R.button('', { kind: 'ghost', size: 'sm', icon: 'trash', aria: 'Remove condition', onClick: () => { spec.match.splice(i, 1); d.update(); refresh(); } }))),
                        h('div', { class: 'row' },
                            R.button('Add condition', { size: 'sm', icon: 'plus', onClick: () => { spec.match.push({ field: fields[0] ? fields[0].name : '', variable: vars[0] || '' }); d.update(); refresh(); } }),
                            spec.match.length > 1 ? R.seg([['AND', 'All match'], ['OR', 'Any matches']], spec.combine, (v) => { spec.combine = v; d.update(); refresh(); }, { label: 'Combine' }) : null))),
                    h('div', { class: 'form-row' },
                        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!spec.bypass, onchange: (e) => { spec.bypass = e.target.checked ? { variable: '', value: '' } : null; d.update(); refresh(); } }),
                            'Every row when a variable has a value (e.g. an administrator flag)'),
                        spec.bypass ? h('div', { class: 'row', style: { marginTop: '8px' } },
                            varInput(spec.bypass.variable, (v) => { spec.bypass.variable = v; }, 'p-bypass-var'),
                            h('span', { class: 'muted', text: '=' }),
                            h('input', { class: 'input', id: 'p-bypass-value', style: { maxWidth: '200px' }, value: spec.bypass.value, oninput: (e) => { spec.bypass.value = e.target.value; refresh(); } })) : null),
                    h('div', { class: 'grid-2' },
                        h('div', { class: 'form-row' }, h('label', { for: 'p-name', text: 'Policy name' }),
                            h('input', { class: 'input mono', id: 'p-name', value: spec.name, placeholder: 'generated from the conditions', oninput: (e) => { spec.name = e.target.value; refresh(); } })),
                        h('div', { class: 'form-row' }, h('label', { text: 'Table' }),
                            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: spec.enable, onchange: (e) => { spec.enable = e.target.checked; refresh(); } }), 'Turn row-level security on'),
                            h('label', { class: 'check', style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: spec.force, onchange: (e) => { spec.force = e.target.checked; refresh(); } }), 'Force it for the table owner too'),
                            role && table.owner === role.user ? h('div', { class: 'help warn-text', text: 'The API connects as the owner (' + role.user + ') — without FORCE no policy applies to it.' }) : null)),
                    unknown().length ? R.notice('warn', 'The API does not set ' + unknown().map((v) => namespace() + '.' + v).join(', '), 'Add the variable under Session variables — unset, it is empty and matches no row.') : null,
                    error ? R.notice('bad', error) : null,
                    sql ? h('div', null, h('div', { class: 'console-head' }, R.icon('code'), h('b', { text: 'SQL' }), R.copyButton(sql)), h('pre', { class: 'code', text: sql })) : null,
                ],
                actions: [
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button('Apply to the database', { kind: 'primary', icon: 'play', disabled: !!error || !sql, onClick: async () => {
                        const r = await R.api('POST', '/rls/apply', R.payload({ operation: { op: 'create', policy: spec } }));
                        if (r.__status >= 400 || !r.ok) { error = r.error || r.message; d.update(); return; }
                        R.toast('ok', 'Policy created on ' + table.table);
                        d.close();
                        await load();
                    } }),
                ],
            }),
        });
        refresh();
    }

    // ── Cards ────────────────────────────────────────────────────────────
    function enforcementCard() {
        const st = S.rls;
        const role = st.connection;
        const admin = st.admin;
        const rows = [];
        if (role) {
            rows.push(h('li', null, R.icon(role.superuser || role.bypassrls ? 'x' : 'check', role.superuser || role.bypassrls ? 'bad-text' : 'ok-text'),
                h('span', null, 'The API connects as ', h('code', { text: role.user }), role.superuser ? ' — a superuser: policies do not apply to it' : role.bypassrls ? ' — BYPASSRLS: policies do not apply to it' : ' — a regular role: policies apply')));
        }
        if (st.supported) {
            rows.push(h('li', null, R.icon(admin && !admin.error ? 'check' : 'info', admin && !admin.error ? 'ok-text' : 'faint'),
                admin ? (admin.error ? h('span', null, 'DATABASE_URL_ADMIN: ', h('span', { class: 'bad-text', text: admin.error })) : h('span', null, 'Sign-in queries connect as ', h('code', { text: admin.user }), admin.superuser ? ' (superuser)' : admin.bypassrls ? ' (BYPASSRLS)' : ''))
                    : h('span', null, 'DATABASE_URL_ADMIN is not set — sign-in uses the API’s connection')));
        }
        return R.card({ title: 'Enforcement', icon: 'lock', description: 'The API sets the variables in every transaction; PostgreSQL filters rows with the policies of each table.' },
            h('div', { class: 'field' },
                h('div', null, h('span', { class: 'name', text: 'Row-level security' }), h('span', { class: 'key', text: 'RLS_ENABLED' })),
                h('div', null, R.seg([['', 'Default (' + (st.provider === 'postgresql' ? 'on' : 'off') + ')'], ['true', 'On'], ['false', 'Off']], R.value('RLS_ENABLED'),
                    (v) => R.setValue('RLS_ENABLED', v, true), { label: 'RLS_ENABLED', disabled: R.info('RLS_ENABLED').locked }),
                h('div', { class: 'help', text: st.active ? 'On: every query runs in a transaction that sets the variables first.' : 'Off: no variables are set — policies that read them see empty values.' }),
                h('div', { class: 'msg', 'data-msg': 'RLS_ENABLED' }))),
            rows.length ? h('div', { class: 'field' }, h('div', null, h('span', { class: 'name', text: 'Database roles' })), h('div', null, h('ul', { class: 'steps', style: { marginTop: 0 } }, rows))) : null,
            st.warnings.length ? h('div', { style: { paddingBottom: '14px' } }, R.notice('warn', 'Not protected yet', h('ul', null, st.warnings.map((w) => h('li', { text: w }))))) : null);
    }

    function variablesCard() {
        const rules = variables();
        const readOnly = S.rls && S.rls.variablesSource === 'code';
        if (!rules) return R.card({ title: 'Session variables', icon: 'sliders' }, h('div', { style: { padding: '14px 0' } }, R.fileNotice('rls')));
        const vars = rules.variables;
        const entries = Object.entries(vars);
        const attrs = (S.rls && S.rls.userAttributes) || ['id'];
        const rename = (oldName, newName) => {
            const next = {};
            for (const [k, v] of entries) next[k === oldName ? newName : k] = v;
            setVariables(next);
        };
        const body = [];
        if (readOnly) body.push(h('div', { style: { padding: '14px 20px 0' } }, R.notice('info', 'Set in code', 'src/config/rls.ts builds the variables with its own function — config/rls.json is not used. Edit the function there.')));
        body.push(h('datalist', { id: 'rls-attrs' }, attrs.map((a) => h('option', { value: a }))));
        if (entries.length) {
            body.push(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Variable', 'Value from', '', 'In a policy', ''].map((t) => h('th', { text: t })))),
                h('tbody', null, entries.map(([name, source], i) => {
                    const [kind, ...rest] = String(source).split('.');
                    const path = rest.join('.');
                    return h('tr', null,
                        h('td', null, h('input', { class: 'input sm mono', id: 'rv-name-' + i, value: name, disabled: readOnly, 'aria-label': 'Variable name',
                            onchange: (e) => rename(name, e.target.value.trim().replace(/[^A-Za-z0-9_]/g, '_')) })),
                        h('td', null, R.select([['user', 'Signed-in user'], ['header', 'Request header']], kind === 'header' ? 'header' : 'user',
                            (v) => setVariables(Object.assign({}, vars, { [name]: v + '.' + (v === 'header' ? 'x-' + name.replace(/_/g, '-') : 'id') })), { size: 'sm', disabled: readOnly, label: 'Source' })),
                        h('td', null, h('input', { class: 'input sm mono', id: 'rv-path-' + i, value: path, disabled: readOnly, list: kind === 'header' ? null : 'rls-attrs', 'aria-label': kind === 'header' ? 'Header' : 'Attribute',
                            placeholder: kind === 'header' ? 'x-gateway-tenant-id' : 'id', onchange: (e) => setVariables(Object.assign({}, vars, { [name]: (kind === 'header' ? 'header.' : 'user.') + e.target.value.trim() })) })),
                        h('td', null, h('code', { class: 'small', text: "current_setting('" + namespace() + '.' + name + "', true)" })),
                        h('td', { class: 'shrink' }, readOnly ? null : R.button('', { kind: 'ghost', size: 'sm', icon: 'trash', aria: 'Remove ' + name, onClick: () => {
                            const next = Object.assign({}, vars);
                            delete next[name];
                            setVariables(next);
                        } })));
                })))));
        } else {
            body.push(R.empty('sliders', 'No variables', 'Policies compare columns with variables the API sets per request — from the signed-in user or a header.'));
        }
        // A client chooses a header's value — isolation must not rest on it alone
        const headerSources = entries.map(([, source]) => String(source)).filter((x) => x.startsWith('header.')).map((x) => x.slice(7)).filter(Boolean);
        if (headerSources.length && !readOnly) {
            body.push(h('div', { style: { padding: '0 20px 14px' } }, R.notice('warn', 'Clients choose header values',
                'Any client can send ' + headerSources.join(', ') + ' with any value. Use a header only when a gateway in front of the API sets it, or when the policy also checks it against the signed-in user (e.g. tenant membership).')));
        }
        // A header browsers send cross-origin must be allowed by CORS
        const allowed = (R.value('CORS_ALLOWED_HEADERS') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
        const headers = headerSources.filter((x) => !allowed.includes(x.toLowerCase()));
        if (headers.length && !readOnly) {
            body.push(h('div', { style: { padding: '0 20px 14px' } }, R.notice('info', 'Browsers need CORS for ' + headers.join(', '),
                'A browser app on another origin may only send the header when CORS_ALLOWED_HEADERS lists it.',
                [R.button('Allow ' + (headers.length === 1 ? 'it' : 'them'), { size: 'sm', icon: 'plus', onClick: () => {
                    const list = (R.value('CORS_ALLOWED_HEADERS') || '').split(',').map((x) => x.trim()).filter(Boolean);
                    R.setValue('CORS_ALLOWED_HEADERS', list.concat(headers.map((x) => x.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase()))).join(', '), true);
                    R.toast('ok', 'CORS_ALLOWED_HEADERS: ' + R.value('CORS_ALLOWED_HEADERS') + ' (unsaved)');
                } })])));
        }
        return R.card({
            title: 'Session variables', icon: 'sliders',
            description: 'Set before every query as ' + namespace() + '.<name>; a missing value is not set. Saved to config/rls.json.',
            actions: [R.fileBadge('rls')], body: 'flush',
            footer: readOnly ? null : [
                R.button('Add variable', { size: 'sm', icon: 'plus', onClick: () => {
                    let n = 1;
                    while (vars['variable_' + n]) n++;
                    setVariables(Object.assign({}, vars, { ['variable_' + n]: 'user.id' }));
                } }),
                PRESETS.filter(([name]) => !vars[name]).map(([name, source, label]) => R.button(label, { size: 'sm', kind: 'ghost', icon: 'plus', onClick: () => setVariables(Object.assign({}, vars, { [name]: source })) })),
            ],
        }, body, R.fileNotice('rls'));
    }

    function tablesCard() {
        const st = S.rls;
        const models = (S.project && S.project.models) || [];
        const open = S.ui.rlsOpen || (S.ui.rlsOpen = {});
        const rows = [];
        for (const t of st.tables) {
            const model = models.find((m) => m.name === t.model);
            const status = !t.exists ? R.badge('No table', 'outline') : !t.enabled ? R.badge('Off', 'outline') : t.forced ? R.badge('On · forced', 'ok', 'lock') : R.badge('On', 'ok', 'lock');
            rows.push(h('tr', null,
                h('td', null, t.policies.length ? h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Show policies', 'aria-expanded': String(!!open[t.model]), onclick: () => { open[t.model] = !open[t.model]; R.render(); } }, R.icon(open[t.model] ? 'chevronDown' : 'chevronRight')) : null),
                h('td', null, h('b', { text: t.table }), t.table !== t.model ? h('div', { class: 'sub', text: 'model ' + t.model }) : null),
                h('td', null, status),
                h('td', null, t.owner ? h('code', { text: t.owner }) : '—'),
                h('td', { class: 'num' }, String(t.policies.length)),
                h('td', { class: 'shrink' }, t.exists ? h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                    R.button('Add policy', { size: 'xs', icon: 'plus', disabled: !model, onClick: () => policyDialog(t, model) }),
                    t.enabled
                        ? R.button(t.forced ? 'Unforce' : 'Force', { size: 'xs', kind: 'ghost', onClick: () => apply({ op: t.forced ? 'noforce' : 'force', model: t.model },
                            (t.forced ? 'Stop forcing' : 'Force') + ' row-level security on ' + t.table + '?',
                            t.forced ? 'The owner (' + t.owner + ') skips the policies again.' : 'The policies bind the owner (' + t.owner + ') too.') })
                        : null,
                    R.button(t.enabled ? 'Turn off' : 'Turn on', { size: 'xs', kind: t.enabled ? 'ghost danger' : 'ghost', onClick: () => apply({ op: t.enabled ? 'disable' : 'enable', model: t.model },
                        (t.enabled ? 'Turn off' : 'Turn on') + ' row-level security for ' + t.table + '?',
                        t.enabled ? 'Every role that can read the table sees all its rows again; its policies stay but do nothing.' : t.policies.length ? 'Its ' + t.policies.length + ' policies apply from now on.' : 'Without a policy no row is visible to the roles it binds — add one first.', t.enabled) })) : null)));
            if (open[t.model]) {
                rows.push(h('tr', null, h('td'), h('td', { colspan: '5', style: { paddingTop: 0 } }, h('div', { class: 'stack' }, t.policies.map((p) => h('div', { class: 'card', style: { margin: 0, boxShadow: 'none' } },
                    h('div', { class: 'card-head', style: { padding: '10px 14px' } },
                        h('div', { class: 'titles' }, h('h2', null, h('code', { text: p.name }), R.badge(p.command, 'brand'), p.permissive ? null : R.badge('restrictive', 'warn')),
                            h('p', { text: 'Roles: ' + (p.roles.join(', ') || 'public') })),
                        R.button('Drop', { size: 'xs', kind: 'ghost danger', icon: 'trash', onClick: () => apply({ op: 'drop', model: t.model, name: p.name }, 'Drop the policy ' + p.name + '?', 'The rows it allows are no longer visible through it.', true) })),
                    h('div', { class: 'card-body pad', style: { padding: '10px 14px' } },
                        p.using ? h('div', null, h('span', { class: 'muted small', text: 'USING ' }), h('code', { text: p.using })) : null,
                        p.check ? h('div', null, h('span', { class: 'muted small', text: 'WITH CHECK ' }), h('code', { text: p.check })) : null)))))));
            }
        }
        return R.card({ title: 'Tables & policies', icon: 'database', description: 'Schema ' + (st.schema || 'public') + '. Changes here run against the database right away' + (R.hasValue('DATABASE_URL_ADMIN') ? ' — with DATABASE_URL_ADMIN.' : '.'), body: 'flush' },
            st.tables.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['', 'Table', 'Row-level security', 'Owner', 'Policies', ''].map((t) => h('th', { text: t })))),
                h('tbody', null, rows))) : R.empty('database', 'No tables', 'The schema has no models yet.'));
    }

    R.page({
        id: 'rls', title: 'Row-level security', group: 'Security', icon: 'lock',
        status: () => {
            if ((S.fileProblems.rls && S.fileProblems.rls.length) || S.state.reasons.some((r) => /rls\.json$/.test(r.key))) return 'bad';
            if (S.rls && S.rls.supported && S.rls.warnings.length) return 'warn';
            return S.rls && S.rls.tables.some((t) => t.enabled && t.policies.length) && !S.rls.warnings.length ? 'ok' : '';
        },
        enter: () => {
            load().catch((err) => R.toast('bad', err.message));
            if (!S.project) R.loadProject().catch(() => undefined);
        },
        render: () => {
            const json = !!S.ui['json-rls'];
            const head = R.pageHead('Row-level security', 'Isolation the database enforces: policies decide which rows each request sees — even a bug in the API cannot leak another tenant’s data. Works alongside access control.', [
                R.button('Refresh', { icon: 'refresh', onClick: load }),
                R.button(json ? 'Editor' : 'JSON', { icon: json ? 'lock' : 'code', onClick: () => { S.ui['json-rls'] = !json; R.render(); } }),
            ]);
            if (json) return [head, R.card({ title: 'config/rls.json', icon: 'file' }, h('div', { style: { padding: '14px 0' } }, R.jsonEditor('rls', '{ "variables": { "<name>": "user.<attribute>" | "header.<name>" } } — each variable is set as ' + namespace() + '.<name> before every query.')))];
            if (!S.rls) return [head, R.loading('Reading the database…')];
            const out = [head];
            if (S.rls.error) out.push(R.notice('warn', 'The database could not be read', S.rls.error));
            if (!S.rls.supported) {
                out.push(R.notice('info', 'MySQL and MariaDB have no row-level security', 'Restrict rows with access control in src/config/acl.ts — Data model & API shows which models have an entry.'));
                return out;
            }
            if (!S.rls.error) out.push(enforcementCard());
            out.push(variablesCard());
            if (S.rls.supported && !S.rls.error) out.push(tablesCard());
            return out;
        },
    });
}

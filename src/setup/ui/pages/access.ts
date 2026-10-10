// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Access control: config/acl.json — per model and role, which rows and fields a user may use */
export function installAccessPage(R) {
    const h = R.h;
    const S = R.S;
    const SCOPES = ['read', 'update', 'delete'];
    const OWNER = /^(user_?id|owner_?id|author_?id|created_?by(_id)?|account_?id|member_?id)$/i;

    function load() {
        const rules = R.fileJson('acl', { models: {} });
        return R.api('POST', '/acl/context', R.payload({ roleField: (rules && rules.roleField) || 'role' })).then((r) => {
            S.acl = r;
            if (S.page === 'access') R.render();
            R.refreshChrome();
        });
    }

    function current() {
        const rules = R.fileJson('acl', { models: {} });
        if (rules && (!rules.models || typeof rules.models !== 'object' || Array.isArray(rules.models))) rules.models = {};
        return rules;
    }
    function write(rules) {
        R.setFileJson('acl', rules);
        R.render();
    }
    /** Change the rules of one model; empty role maps are dropped */
    function edit(name, fn) {
        const rules = current();
        if (!rules) return;
        const model = rules.models[name] || (rules.models[name] = {});
        fn(model, rules);
        for (const action of Object.keys(model)) {
            if (model[action] && typeof model[action] === 'object' && !Array.isArray(model[action]) && Object.keys(model[action]).length === 0) delete model[action];
        }
        write(rules);
    }

    function rolesOf(rules) {
        const roles = new Set((S.acl && S.acl.roles) || []);
        for (const model of Object.values((rules && rules.models) || {})) {
            for (const byRole of Object.values(model || {})) if (byRole && typeof byRole === 'object') for (const role of Object.keys(byRole)) if (role !== '*') roles.add(role);
        }
        for (const role of S.ui.extraRoles || []) roles.add(role);
        return [...roles];
    }
    const roleLabel = (role) => (role === '*' ? 'Everyone else' : role);
    const describeWhere = (where) => Object.entries(where || {}).map(([k, v]) => k + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ') || '{ }';

    // ── Row filter ───────────────────────────────────────────────────────
    function simpleConditions(where) {
        const out = [];
        for (const [field, value] of Object.entries(where || {})) {
            if (['AND', 'OR', 'NOT'].includes(field) || (value !== null && typeof value === 'object')) return null;
            out.push({ field, value });
        }
        return out;
    }
    /** The where of a scope, edited as conditions (field = $user.<attribute> or a value) or as JSON */
    function whereDialog(model, where, onSave) {
        const fields = model.fields.filter((f) => !f.isList);
        const attrs = (S.acl && S.acl.userAttributes) || ['id'];
        const guess = fields.find((f) => OWNER.test(f.name));
        let conditions = simpleConditions(where);
        let json = conditions === null;
        if (conditions && conditions.length === 0) conditions = [{ field: guess ? guess.name : fields[0] ? fields[0].name : '', value: '$user.id' }];
        let jsonText = JSON.stringify(where || {}, null, 2);
        let error = '';
        const typed = (field, text) => {
            const f = fields.find((x) => x.name === field);
            if (typeof text !== 'string' || text.startsWith('$user.')) return text;
            if (f && ['Int', 'BigInt', 'Float', 'Decimal'].includes(f.type) && text.trim() !== '' && !isNaN(Number(text))) return Number(text);
            if (f && f.type === 'Boolean' && (text === 'true' || text === 'false')) return text === 'true';
            return text;
        };
        const d = R.dialog({
            title: 'Rows of ' + model.name, wide: true,
            // A cancelled “Matching rows…” goes back to what the rule says
            onClose: () => R.render(),
            render: () => ({
                body: [
                    h('p', { class: 'muted', style: { marginTop: 0 }, text: 'The rows this role may use: those where every condition matches. $user values come from the signed-in user — a user without the attribute gets no rows.' }),
                    json ? h('div', null,
                        h('textarea', { class: 'input', id: 'where-json', style: { minHeight: '180px' }, value: jsonText, spellcheck: 'false', oninput: (e) => { jsonText = e.target.value; } }),
                        h('div', { class: 'help muted small', style: { marginTop: '6px' }, text: 'A Prisma where object, e.g. { "OR": [{ "owner_id": "$user.id" }, { "public": true }] }.' }))
                        : h('div', { class: 'stack' }, conditions.map((c, i) => {
                            const isRef = typeof c.value === 'string' && c.value.startsWith('$user.');
                            return h('div', { class: 'row' },
                                R.select(fields.map((f) => [f.name, f.name + ' · ' + f.type]), c.field, (v) => { c.field = v; d.update(); }, { id: 'w-field-' + i, label: 'Field' }),
                                h('span', { class: 'muted', text: 'equals' }),
                                R.select(attrs.map((a) => ['$user.' + a, 'the user’s ' + a]).concat([['__fixed', 'a fixed value…']]), isRef ? c.value : '__fixed',
                                    (v) => { c.value = v === '__fixed' ? '' : v; d.update(); }, { id: 'w-src-' + i, label: 'Value' }),
                                isRef ? null : h('input', { class: 'input', id: 'w-val-' + i, style: { maxWidth: '200px' }, value: c.value === undefined || c.value === null ? '' : String(c.value), placeholder: 'value',
                                    oninput: (e) => { c.value = e.target.value; } }),
                                R.button('', { kind: 'ghost', size: 'sm', icon: 'trash', aria: 'Remove condition', onClick: () => { conditions.splice(i, 1); d.update(); } }));
                        }), h('div', null, R.button('Add condition', { size: 'sm', icon: 'plus', onClick: () => { conditions.push({ field: fields[0] ? fields[0].name : '', value: '$user.id' }); d.update(); } }))),
                    error ? R.notice('bad', error) : null,
                ],
                actions: [
                    h('div', { class: 'left' }, R.button(json ? 'Use conditions' : 'Edit as JSON', { kind: 'ghost', size: 'sm', icon: 'code', disabled: json && simpleConditions(safeParse(jsonText)) === null, onClick: () => {
                        if (json) { conditions = simpleConditions(safeParse(jsonText)) || []; json = false; } else { jsonText = JSON.stringify(build(), null, 2); json = true; }
                        error = '';
                        d.update();
                    } })),
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button('Apply', { kind: 'primary', onClick: () => {
                        let value;
                        if (json) {
                            value = safeParse(jsonText);
                            if (!value || typeof value !== 'object' || Array.isArray(value)) { error = 'A JSON object is needed'; d.update(); return; }
                        } else {
                            value = build();
                            if (Object.keys(value).length === 0) { error = 'Add at least one condition — or choose “No rows”'; d.update(); return; }
                        }
                        onSave(value);
                        d.close();
                    } }),
                ],
            }),
        });
        function build() {
            const out = {};
            for (const c of conditions) if (c.field) out[c.field] = typed(c.field, c.value);
            return out;
        }
    }
    function safeParse(text) {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    function fieldsDialog(model, title, text, selected, onSave, allowAll) {
        const names = model.fields.map((f) => f.name).concat(Object.keys(model.relations || {}));
        let picked = new Set(selected || []);
        let all = allowAll && selected === 'all';
        const d = R.dialog({
            title,
            render: () => ({
                body: [
                    h('p', { class: 'muted', style: { marginTop: 0 }, text }),
                    allowAll ? h('div', { style: { marginBottom: '12px' } }, R.seg([['all', 'All fields'], ['list', 'Only these']], all ? 'all' : 'list', (v) => { all = v === 'all'; d.update(); })) : null,
                    all ? null : h('div', { class: 'grid-3' }, names.map((n) => h('label', { class: 'check' },
                        h('input', { type: 'checkbox', checked: picked.has(n), onchange: (e) => { if (e.target.checked) picked.add(n); else picked.delete(n); } }),
                        h('span', null, n, model.sensitive.includes(n) ? h('span', { class: 'warn-text small', text: ' · credential' }) : null, model.relations && model.relations[n] ? h('span', { class: 'faint small', text: ' · ' + model.relations[n] }) : null)))),
                ],
                actions: [
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button('Apply', { kind: 'primary', onClick: () => { onSave(all ? 'all' : names.filter((n) => picked.has(n))); d.close(); } }),
                ],
            }),
        });
    }

    // ── Presets ──────────────────────────────────────────────────────────
    function presetDialog(model, roles) {
        const owners = model.fields.filter((f) => !f.isList && !f.isId && OWNER.test(f.name)).concat(model.fields.filter((f) => !f.isList && !OWNER.test(f.name) && /id$/i.test(f.name) && !f.isId));
        const choice = { preset: owners.length ? 'owner' : 'signed-in', owner: owners[0] ? owners[0].name : '', admin: roles.find((r) => /admin/i.test(r)) || roles[0] || 'admin' };
        const hide = model.sensitive.length ? { hide: { '*': model.sensitive.slice() } } : {};
        const presets = {
            'signed-in': ['Signed-in users: full access', 'Every signed-in user may create, read, update and delete every row.',
                () => Object.assign({ create: { '*': true }, read: { '*': 'all' }, update: { '*': 'all' }, delete: { '*': 'all' } }, hide)],
            owner: ['Own rows — administrators all', 'Users see and change the rows they own; the administrator role sees everything.',
                () => Object.assign({ create: { '*': true },
                    read: { [choice.admin]: 'all', '*': { where: { [choice.owner]: '$user.id' } } },
                    update: { [choice.admin]: 'all', '*': { where: { [choice.owner]: '$user.id' } } },
                    delete: { [choice.admin]: 'all', '*': { where: { [choice.owner]: '$user.id' } } } }, hide)],
            'read-all': ['Everyone reads — administrators write', 'Every signed-in user reads every row; only the administrator role creates, changes and deletes.',
                () => Object.assign({ create: { [choice.admin]: true, '*': false }, read: { '*': 'all' }, update: { [choice.admin]: 'all', '*': 'none' }, delete: { [choice.admin]: 'all', '*': 'none' } }, hide)],
            admins: ['Administrators only', 'Only the administrator role has access.',
                () => Object.assign({ create: { [choice.admin]: true, '*': false }, read: { [choice.admin]: 'all', '*': 'none' }, update: { [choice.admin]: 'all', '*': 'none' }, delete: { [choice.admin]: 'all', '*': 'none' } }, hide)],
            none: ['No access', 'Nobody may use the model through the API (system code still can).', () => ({ create: { '*': false }, read: { '*': 'none' }, update: { '*': 'none' }, delete: { '*': 'none' } })],
        };
        const d = R.dialog({
            title: 'Apply a preset to ' + model.name, wide: true,
            render: () => ({
                body: [
                    h('div', { class: 'stack' }, Object.entries(presets).map(([id, [title, text]]) => h('label', { class: 'check', style: { alignItems: 'flex-start', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: '10px', background: choice.preset === id ? 'var(--brand-soft)' : 'var(--surface)' } },
                        h('input', { type: 'radio', name: 'preset', checked: choice.preset === id, style: { marginTop: '3px' }, onchange: () => { choice.preset = id; d.update(); } }),
                        h('span', null, h('b', { text: title }), h('div', { class: 'muted small', text: text }))))),
                    ['owner', 'read-all', 'admins'].includes(choice.preset) ? h('div', { class: 'grid-2', style: { marginTop: '14px' } },
                        h('div', { class: 'form-row' }, h('label', { for: 'preset-admin', text: 'Administrator role' }),
                            h('input', { class: 'input', id: 'preset-admin', list: 'preset-roles', value: choice.admin, oninput: (e) => { choice.admin = e.target.value.trim(); } }),
                            h('datalist', { id: 'preset-roles' }, roles.map((r) => h('option', { value: r })))),
                        choice.preset === 'owner' ? h('div', { class: 'form-row' }, h('label', { for: 'preset-owner', text: 'Owner column' }),
                            R.select(model.fields.filter((f) => !f.isList).map((f) => [f.name, f.name]), choice.owner, (v) => { choice.owner = v; }, { id: 'preset-owner' }),
                            h('div', { class: 'help', text: 'Holds the id of the user who owns the row.' })) : null) : null,
                    model.sensitive.length && choice.preset !== 'none' ? h('p', { class: 'muted small', text: 'Credential fields stay hidden: ' + model.sensitive.join(', ') + '.' }) : null,
                ],
                actions: [
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button('Apply preset', { kind: 'primary', onClick: () => {
                        if (['owner', 'read-all', 'admins'].includes(choice.preset) && !choice.admin) return R.toast('bad', 'Name the administrator role');
                        if (choice.preset === 'owner' && !choice.owner) return R.toast('bad', 'Choose the owner column');
                        const rules = current();
                        rules.models[model.name] = presets[choice.preset][2]();
                        write(rules);
                        d.close();
                        R.toast('ok', presets[choice.preset][0] + ' — applied to ' + model.name + ' (unsaved)');
                    } }),
                ],
            }),
        });
    }

    // ── Matrix ───────────────────────────────────────────────────────────
    function scopeCell(model, rule, action, role, readOnly) {
        const byRole = rule[action] || {};
        const has = Object.prototype.hasOwnProperty.call(byRole, role);
        const value = has ? byRole[role] : undefined;
        const kind = value === 'all' ? 'all' : value === 'none' ? 'none' : value && typeof value === 'object' ? 'where' : role === '*' ? 'none' : 'inherit';
        const options = (role === '*' ? [] : [['inherit', 'As everyone else']]).concat([['all', 'All rows'], ['none', 'No rows'], ['where', 'Matching rows…']]);
        const set = (next) => edit(model.name, (m) => {
            m[action] = m[action] || {};
            if (next === undefined) delete m[action][role]; else m[action][role] = next;
        });
        return h('td', null,
            R.select(options, kind, (v) => {
                if (v === 'inherit') set(undefined);
                else if (v === 'all' || v === 'none') set(v);
                else whereDialog(model, kind === 'where' ? value.where : {}, (where) => set({ where }));
            }, { size: 'sm', disabled: readOnly, label: action + ' — ' + roleLabel(role) }),
            kind === 'where' ? h('button', { class: 'filter-chip', type: 'button', title: 'Edit the filter', disabled: readOnly,
                onclick: () => whereDialog(model, value.where, (where) => set({ where })) }, R.icon('edit'), h('span', { text: describeWhere(value.where) })) : null);
    }

    function createCell(model, rule, role, readOnly) {
        const byRole = rule.create || {};
        const has = Object.prototype.hasOwnProperty.call(byRole, role);
        const value = has ? (byRole[role] ? 'yes' : 'no') : role === '*' ? 'no' : 'inherit';
        const options = (role === '*' ? [] : [['inherit', 'As everyone else']]).concat([['yes', 'Allowed'], ['no', 'Denied']]);
        return h('td', null, R.select(options, value, (v) => edit(model.name, (m) => {
            m.create = m.create || {};
            if (v === 'inherit') delete m.create[role]; else m.create[role] = v === 'yes';
        }), { size: 'sm', disabled: readOnly, label: 'create — ' + roleLabel(role) }));
    }

    function listCell(model, rule, action, role, readOnly) {
        const byRole = rule[action] || {};
        const has = Object.prototype.hasOwnProperty.call(byRole, role);
        const value = has ? byRole[role] : undefined;
        const label = !has ? (role === '*' ? (action === 'write' ? 'All fields' : 'None') : 'As everyone else')
            : value === 'all' ? 'All fields' : value.length === 0 ? 'None' : value.length <= 2 ? value.join(', ') : value.length + ' fields';
        const open = () => fieldsDialog(model,
            (action === 'hide' ? 'Hidden fields' : 'Writable fields') + ' — ' + roleLabel(role),
            action === 'hide' ? 'Never returned to this role.' : 'The only fields this role may set when creating or updating.',
            has ? value : action === 'write' ? 'all' : [],
            (next) => edit(model.name, (m) => {
                m[action] = m[action] || {};
                if (action === 'write' && next === 'all' && role === '*') delete m[action][role];
                else m[action][role] = next;
            }), action === 'write');
        return h('td', null,
            h('button', { type: 'button', class: 'btn sm' + (has ? '' : ' ghost'), disabled: readOnly, title: Array.isArray(value) ? value.join(', ') : null, onclick: open },
                h('span', { class: has ? '' : 'inherit', text: label })),
            has && role !== '*' && !readOnly ? R.button('', { kind: 'ghost', size: 'xs', icon: 'undo', aria: 'Use everyone else’s', title: 'Use everyone else’s', onClick: () => edit(model.name, (m) => { delete m[action][role]; }) }) : null);
    }

    function matrix(model, rule, roles, readOnly) {
        const used = new Set();
        for (const byRole of Object.values(rule)) if (byRole && typeof byRole === 'object') for (const role of Object.keys(byRole)) used.add(role);
        const rows = [...used].filter((r) => r !== '*').sort().concat(['*']);
        const addable = roles.filter((r) => !used.has(r));
        const roleCell = (role) => h('td', { class: 'role' }, h('b', { text: roleLabel(role) }),
            role === '*' ? h('div', { class: 'sub', text: 'roles without a row' }) : h('div', { class: 'sub mono', text: role }));
        const removeCell = (role) => h('td', { class: 'shrink' }, role === '*' || readOnly ? null : R.button('', { kind: 'ghost', size: 'sm', icon: 'trash', aria: 'Remove the row of ' + role,
            onClick: () => edit(model.name, (m) => { for (const action of Object.keys(m)) if (m[action] && typeof m[action] === 'object') delete m[action][role]; }) }));
        return h('div', null,
            h('div', { class: 'table-wrap' }, h('table', { class: 'table matrix' },
                h('thead', null, h('tr', null, ['Role', 'Create', 'Read', 'Update', 'Delete', ''].map((t) => h('th', { text: t })))),
                h('tbody', null, rows.map((role) => h('tr', null, roleCell(role), createCell(model, rule, role, readOnly),
                    SCOPES.map((a) => scopeCell(model, rule, a, role, readOnly)), removeCell(role)))))),
            h('div', { class: 'table-wrap', style: { borderTop: '1px solid var(--border)' } }, h('table', { class: 'table matrix' },
                h('thead', null, h('tr', null, h('th', { text: 'Fields' }), h('th', { text: 'Hidden — never returned' }), h('th', { text: 'Writable — the only ones it may set' }))),
                h('tbody', null, rows.map((role) => h('tr', null, roleCell(role), listCell(model, rule, 'hide', role, readOnly), listCell(model, rule, 'write', role, readOnly)))))),
            readOnly ? null : h('div', { class: 'row', style: { padding: '12px 14px', borderTop: '1px solid var(--border)' } },
                h('span', { class: 'muted small', text: 'Add a row for a role:' }),
                h('input', { class: 'input sm', id: 'acl-add-role', list: 'acl-roles', placeholder: 'role name', style: { maxWidth: '200px' },
                    onkeydown: (e) => { if (e.key === 'Enter') addRole(e.target.value); } }),
                h('datalist', { id: 'acl-roles' }, addable.map((r) => h('option', { value: r }))),
                R.button('Add', { size: 'sm', icon: 'plus', onClick: () => addRole(document.getElementById('acl-add-role').value) })));

        function addRole(value) {
            const role = String(value || '').trim();
            if (!role || role === '*') return;
            S.ui.extraRoles = Array.from(new Set((S.ui.extraRoles || []).concat([role])));
            // A role row starts with an explicit read rule, copied from everyone else
            edit(model.name, (m) => {
                m.read = m.read || {};
                if (!Object.prototype.hasOwnProperty.call(m.read, role)) m.read[role] = m.read['*'] !== undefined ? m.read['*'] : 'none';
            });
        }
    }

    function modelEditor(model, rules, roles) {
        const rule = rules.models[model.name];
        const readOnly = model.code;
        const actions = readOnly ? [] : [
            R.button('Preset…', { size: 'sm', icon: 'shield', onClick: () => presetDialog(model, roles) }),
            rule ? R.button('Remove rules', { size: 'sm', kind: 'danger', icon: 'trash', onClick: async () => {
                if (!(await R.confirm({ title: 'Remove the rules of ' + model.name + '?', text: R.value('ACL_DEFAULT') === 'deny' ? 'Without rules the model is closed (ACL_DEFAULT=deny).' : 'Without rules every signed-in user has full access (ACL_DEFAULT=allow).', confirm: 'Remove', danger: true }))) return;
                const next = current();
                delete next.models[model.name];
                write(next);
            } }) : null,
        ];
        const body = [];
        if (readOnly) body.push(h('div', { style: { padding: '14px 20px 0' } }, R.notice('info', 'Defined in code', h('span', null, (S.acl.codeFile || 'src/config/acl.ts') + ' has an entry for ' + model.name + ' — it takes precedence; rules here are not used. Change it in the code.'))));
        if (!rule && !readOnly) {
            body.push(R.empty('shield', 'No rules for ' + model.name,
                R.value('ACL_DEFAULT') === 'deny' ? 'The model is closed: ACL_DEFAULT=deny keeps models without rules inaccessible.' : 'Every signed-in user has full access: ACL_DEFAULT=allow leaves models without rules open.',
                [R.button('Add default rules', { kind: 'primary', icon: 'plus', onClick: () => { const next = current(); next.models[model.name] = R.defaultRules(model); write(next); } }),
                    R.button('Choose a preset…', { icon: 'shield', onClick: () => presetDialog(model, roles) })]));
        } else if (rule) {
            body.push(matrix(model, rule, roles, readOnly));
        }
        return R.card({
            title: model.name, icon: 'layers',
            description: 'Table ' + model.table + ' · ' + model.fields.length + ' fields' + (model.sensitive.length ? ' · credentials: ' + model.sensitive.join(', ') : ''),
            actions, body: 'flush',
        }, body);
    }

    function policyCard(rules, roles) {
        const field = rules.roleField || 'role';
        const candidates = Array.from(new Set([field].concat(S.acl.roleFieldCandidates || [])));
        const aclDefault = R.value('ACL_DEFAULT') || 'allow';
        return R.card({ title: 'Policy', icon: 'shield', description: 'How rules apply. Rules are checked on every request of a signed-in user; the system user (internal code) is not bound by them.' },
            h('div', { class: 'field' },
                h('div', null, h('span', { class: 'name', text: 'Models without rules' }), h('span', { class: 'key', text: 'ACL_DEFAULT' })),
                h('div', null, R.seg([['allow', 'Open to signed-in users'], ['deny', 'Closed']], aclDefault, (v) => {
                    R.setValue('ACL_DEFAULT', v === 'allow' && !R.info('ACL_DEFAULT').hasValue ? '' : v, true);
                }, { label: 'Models without rules', disabled: R.info('ACL_DEFAULT').locked }),
                h('div', { class: 'help', text: 'Closed is the safe choice: a new table stays inaccessible until it has rules.' }),
                h('div', { class: 'msg', 'data-msg': 'ACL_DEFAULT' }))),
            h('div', { class: 'field' },
                h('div', null, h('span', { class: 'name', text: 'Role field' }), h('span', { class: 'key', text: 'roleField' })),
                h('div', null,
                    R.select(candidates.map((c) => [c, c]), field, (v) => {
                        const next = current();
                        if (v === 'role') delete next.roleField; else next.roleField = v;
                        write(next);
                        load();
                    }, { id: 'acl-role-field', label: 'Role field' }),
                    h('div', { class: 'help', text: 'The attribute of the signed-in user that names its role' + (S.acl.userModel ? ' — a column of ' + S.acl.userModel : '') + '. Known roles: ' + (roles.length ? roles.join(', ') : 'none yet — add role rows to a model') + '.' }))));
    }

    R.page({
        id: 'access', title: 'Access control', group: 'Security', icon: 'shield',
        status: () => {
            if (S.fileProblems.acl && S.fileProblems.acl.length) return 'bad';
            if (S.state.reasons.some((r) => /acl\.json$/.test(r.key))) return 'bad';
            const p = S.state.project;
            if (p.schema.models.length === 0) return '';
            const rules = R.fileJson('acl', { models: {} });
            const covered = (rules && rules.models) || {};
            const missing = p.schema.models.filter((m) => !covered[m] && !(S.acl && S.acl.models.some((x) => x.name === m && x.code)));
            return missing.length === 0 ? 'ok' : 'warn';
        },
        enter: () => { load().catch((err) => R.toast('bad', err.message)); },
        render: () => {
            const json = !!S.ui['json-acl'];
            const head = R.pageHead('Access control', 'Who may create, read, update and delete which rows of each model — and which fields they see and may write. Saved to config/acl.json.', [
                R.fileBadge('acl'),
                R.button(json ? 'Editor' : 'JSON', { icon: json ? 'shield' : 'code', onClick: () => { S.ui['json-acl'] = !json; R.render(); } }),
            ]);
            if (json) return [head, R.card({ title: 'config/acl.json', icon: 'file' }, h('div', { style: { padding: '14px 0' } }, R.jsonEditor('acl', 'Per model and role: "create" true/false; "read", "update", "delete" "all", "none" or { "where": {…} } ("$user.<attribute>" values); "hide" and "write" field lists. "*" covers every role not listed.')))];
            if (!S.acl) return [head, R.loading('Reading the models…')];
            const out = [head];
            const notice = R.fileNotice('acl');
            if (notice) out.push(notice);
            const rules = current();
            if (!rules) return out;
            if (S.acl.codeError) out.push(R.notice('warn', 'src/config/acl.ts could not be loaded', S.acl.codeError));
            if (S.acl.models.length === 0) {
                out.push(R.card({}, R.empty('layers', 'No models yet', 'Access rules are per model — get the data model first.', [R.button('Data model & API', { kind: 'primary', icon: 'layers', onClick: () => R.go('model') })])));
                return out;
            }
            const roles = rolesOf(rules);
            if (R.signInOff()) {
                out.push(R.notice('info', 'No sign-in: every request is anonymous', 'The rows for the role “anonymous” — else “Everyone else” — decide what any caller may do. Rules on $user values give anonymous requests no rows.'));
            }
            out.push(policyCard(rules, roles));

            const without = S.acl.models.filter((m) => !m.code && !rules.models[m.name]);
            if (without.length) {
                out.push(R.notice('warn', without.length + ' model' + (without.length === 1 ? ' has' : 's have') + ' no rules',
                    (R.value('ACL_DEFAULT') === 'deny' ? 'They are closed (ACL_DEFAULT=deny): ' : 'They are open to every signed-in user (ACL_DEFAULT=allow): ') + without.map((m) => m.name).join(', '),
                    [R.button('Add default rules to all of them', { size: 'sm', icon: 'plus', onClick: () => {
                        const added = R.addDefaultRules(without.map((m) => m.name), S.acl.models);
                        R.toast('ok', 'Default rules added for ' + added + ' model' + (added === 1 ? '' : 's') + ' (unsaved)');
                        R.render();
                    } })]));
            }

            const selectedName = S.sub && S.acl.models.some((m) => m.name === S.sub) ? S.sub : S.ui.aclModel && S.acl.models.some((m) => m.name === S.ui.aclModel) ? S.ui.aclModel : S.acl.models[0].name;
            const q = (S.ui.aclSearch || '').toLowerCase();
            const filter = S.ui.aclFilter || 'all';
            const list = S.acl.models.filter((m) => (!q || m.name.toLowerCase().includes(q))
                && (filter === 'all' || (filter === 'none' && !m.code && !rules.models[m.name]) || (filter === 'rules' && !m.code && rules.models[m.name]) || (filter === 'code' && m.code)));
            const selected = S.acl.models.find((m) => m.name === selectedName);
            out.push(h('div', { class: 'split' },
                h('div', { class: 'list-panel' },
                    h('div', { class: 'tools' },
                        R.search(S.ui.aclSearch, (v) => { S.ui.aclSearch = v; R.render(); }, 'Filter models', 'acl-search'),
                        R.select([['all', 'All models'], ['none', 'Without rules'], ['rules', 'With rules'], ['code', 'Defined in code']], filter, (v) => { S.ui.aclFilter = v; R.render(); }, { size: 'sm', label: 'Show' })),
                    h('div', { class: 'items', role: 'listbox', 'aria-label': 'Models' }, list.map((m) => h('button', {
                        class: 'list-item' + (m.name === selectedName ? ' active' : ''), role: 'option', 'aria-selected': String(m.name === selectedName),
                        onclick: () => { S.ui.aclModel = m.name; R.go('access', m.name); },
                    }, h('span', { class: 'name', text: m.name }),
                    m.code ? R.badge('Code', 'brand') : rules.models[m.name] ? R.icon('check', 'ok-text') : R.badge('None', 'warn'))),
                    list.length === 0 ? h('div', { class: 'muted small', style: { padding: '10px' }, text: 'No model matches.' }) : null)),
                h('div', null, selected ? modelEditor(selected, rules, roles) : null,
                    h('p', { class: 'muted small', text: 'A role without its own row uses “Everyone else”. Nothing is granted that no rule allows — a role in no row and without “Everyone else” has no access. Changes are saved with Review & start.' }))));
            return out;
        },
    });
}

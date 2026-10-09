// @ts-nocheck — browser code, serialized into the wizard page (see ./index.ts).

/** Building blocks shared by the pages: buttons, cards, setting fields, tests, editors, diffs */
export function installComponents(R) {
    const h = R.h;
    const S = R.S;

    // ── Basics ───────────────────────────────────────────────────────────
    /** A button; when onClick returns a promise it shows a spinner until it settles */
    R.button = (label, o) => {
        o = o || {};
        const btn = h('button', {
            type: o.type || 'button',
            class: 'btn' + (o.kind ? ' ' + o.kind : '') + (o.size ? ' ' + o.size : ''),
            disabled: o.disabled, title: o.title, id: o.id, 'aria-label': o.aria,
        }, o.icon ? R.icon(o.icon) : null, label);
        if (o.onClick) {
            btn.addEventListener('click', async (e) => {
                const result = o.onClick(e);
                if (result && typeof result.then === 'function') {
                    const content = [...btn.childNodes];
                    btn.disabled = true;
                    btn.replaceChildren(h('span', { class: 'spin' }), o.busy || label);
                    try {
                        await result;
                    } catch (err) {
                        R.toast('bad', String((err && err.message) || err));
                    } finally {
                        if (btn.isConnected) {
                            btn.disabled = !!o.disabled;
                            btn.replaceChildren(...content);
                        }
                    }
                }
            });
        }
        return btn;
    };

    R.badge = (text, kind, icon) => h('span', { class: 'badge' + (kind ? ' ' + kind : '') }, icon ? R.icon(icon) : null, text);

    R.notice = (kind, title, body, actions) => h('div', { class: 'notice ' + kind, role: kind === 'bad' ? 'alert' : null },
        R.icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert', 'lg'),
        h('div', { class: 'body' },
            title ? h('div', { class: 'title' }, title) : null,
            typeof body === 'string' ? h('div', { text: body }) : body || null,
            actions && actions.length ? h('div', { class: 'actions' }, actions) : null));

    R.pageHead = (title, description, actions, crumbs) => h('div', { class: 'page-head' },
        h('div', { class: 'titles' },
            crumbs ? h('div', { class: 'crumbs' }, crumbs) : null,
            h('h1', { text: title }),
            description ? h('p', null, description) : null),
        actions && actions.length ? h('div', { class: 'actions' }, actions) : null);

    R.card = (o, ...children) => h('section', { class: 'card' + (o.compact ? ' compact' : ''), id: o.id },
        o.title ? h('div', { class: 'card-head' },
            h('div', { class: 'titles' }, h('h2', null, o.icon ? R.icon(o.icon) : null, o.title, o.badge || null), o.description ? h('p', null, o.description) : null),
            o.actions && o.actions.length ? h('div', { class: 'actions' }, o.actions) : null) : null,
        children.some((c) => c !== null && c !== undefined && c !== false && !(Array.isArray(c) && c.length === 0)) ? h('div', { class: 'card-body' + (o.body ? ' ' + o.body : '') }, children) : null,
        o.footer ? h('div', { class: 'card-foot' }, o.footer) : null);

    R.loading = (text) => h('div', { class: 'loading' }, h('span', { class: 'spin' }), text || 'Loading…');

    R.empty = (icon, title, text, actions) => h('div', { class: 'empty' }, R.icon(icon), h('div', { class: 'title', text: title }),
        text ? h('div', { text }) : null, actions && actions.length ? h('div', { class: 'actions' }, actions) : null);

    R.seg = (options, value, onChange, o) => h('div', { class: 'seg', role: 'radiogroup', 'aria-label': (o && o.label) || null },
        options.map(([v, label]) => h('button', {
            type: 'button', class: value === v ? 'on' : '', role: 'radio', 'aria-checked': String(value === v), disabled: o && o.disabled,
            onclick: () => onChange(v),
        }, label)));

    R.select = (options, value, onChange, o) => {
        o = o || {};
        return h('select', { class: 'input' + (o.size ? ' ' + o.size : '') + (o.mono ? ' mono' : ''), id: o.id, disabled: o.disabled, 'aria-label': o.label, value,
            onchange: (e) => onChange(e.target.value) },
        options.map((opt) => (Array.isArray(opt) ? h('option', { value: opt[0], text: opt[1] }) : h('option', { value: opt, text: opt }))));
    };

    R.search = (value, onInput, placeholder, id) => h('div', { class: 'search' }, R.icon('search'),
        h('input', { class: 'input', type: 'search', id: id || null, value: value || '', placeholder: placeholder || 'Search', 'aria-label': placeholder || 'Search',
            oninput: (e) => onInput(e.target.value) }));

    R.copyButton = (text, label) => R.button(label || 'Copy', { size: 'sm', icon: 'copy', onClick: () => {
        navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => R.toast('ok', 'Copied to the clipboard'), () => R.toast('bad', 'Copying is not allowed here'));
    } });

    R.stat = (icon, label, value, hint, cls) => h('div', { class: 'stat' },
        h('div', { class: 'label' }, R.icon(icon), label),
        h('div', { class: 'value ' + (cls || ''), title: value, text: value }),
        hint ? h('div', { class: 'hint', title: hint, text: hint }) : null);

    /** The outcome of a test or check: { ok, message, steps?, details? } */
    R.result = (r) => {
        if (!r) return null;
        const items = [];
        if (r.steps) for (const s of r.steps) {
            items.push(h('li', null, R.icon(s.ok ? 'check' : 'x', s.ok ? 'ok-text' : 'bad-text'), h('span', null, h('b', { text: s.target }), ' — ' + s.message)));
        }
        if (r.details) for (const k of Object.keys(r.details)) {
            let v = r.details[k];
            if (Array.isArray(v)) v = v.length + (v.length ? ': ' + v.slice(0, 30).join(', ') + (v.length > 30 ? ', …' : '') : '');
            else if (v && typeof v === 'object') v = JSON.stringify(v);
            items.push(h('li', null, R.icon('chevronRight', 'faint'), h('span', null, k.replace(/_/g, ' ') + ': ' + v)));
        }
        return h('div', { class: 'result' }, R.notice(r.ok ? 'ok' : 'bad', r.message, items.length ? h('ul', { class: 'steps' }, items) : null));
    };

    R.console = (title, output, ok) => h('div', { style: { marginTop: '14px' } },
        h('div', { class: 'console-head' }, R.icon('terminal'), h('b', { text: title }), ok === undefined ? null : R.badge(ok ? 'finished' : 'failed', ok ? 'ok' : 'bad')),
        h('pre', { class: 'console', text: output || '(no output)' }));

    // ── Settings fields ──────────────────────────────────────────────────
    function randomSecret() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
    }
    R.randomSecret = randomSecret;

    R.fieldInput = (setting) => {
        const key = setting.key;
        const info = R.info(key);
        const locked = info.locked;
        const value = R.value(key);
        const id = 'f-' + key;
        if (setting.type === 'boolean') {
            return R.seg([['', 'Default' + (setting.default ? ' (' + setting.default + ')' : '')], ['true', 'Yes'], ['false', 'No']], value,
                (v) => R.setValue(key, v, true), { label: setting.label, disabled: locked });
        }
        if (setting.type === 'enum') {
            return R.select([['', 'Default' + (setting.default ? ' — ' + setting.default : '')]].concat((setting.options || []).map((o) => [o, o])), value,
                (v) => R.setValue(key, v), { id, disabled: locked, label: setting.label });
        }
        if (setting.type === 'multi') {
            const items = value ? value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : [];
            // An exclusive option (none) stands alone: choosing it clears the others, and back
            const alone = setting.exclusive || [];
            const ordered = items.filter((x) => !alone.includes(x));
            return h('div', null,
                h('div', { class: 'chips', role: 'group', 'aria-label': setting.label }, (setting.options || []).map((o) => {
                    const on = items.includes(o);
                    const next = alone.includes(o) ? (on ? [] : [o]) : on ? items.filter((x) => x !== o) : ordered.concat([o]);
                    return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), disabled: locked, 'aria-pressed': String(on),
                        onclick: () => R.setValue(key, next.join(','), true) },
                    on && !alone.includes(o) ? h('span', { class: 'ord', text: String(ordered.indexOf(o) + 1) }) : on ? R.icon('check') : null,
                    (setting.labels && setting.labels[o]) || o);
                })),
                ordered.length > 1 ? h('div', { class: 'help', text: 'Tried in this order: ' + ordered.join(' → ') + '. Click to remove, click again to add at the end.' }) : null);
        }
        if (setting.type === 'json') {
            return h('textarea', { class: 'input', id, disabled: locked, spellcheck: 'false', placeholder: setting.placeholder || '', value,
                oninput: (e) => R.setValue(key, e.target.value) });
        }
        const secret = R.isSecret(setting);
        const input = h('input', {
            class: 'input' + (secret || setting.type === 'url' ? ' mono' : ''), id, disabled: locked, spellcheck: 'false',
            type: secret && !S.reveal[key] ? 'password' : 'text',
            autocomplete: secret ? 'new-password' : 'off',
            inputmode: setting.type === 'number' ? 'numeric' : null,
            placeholder: secret && info.hasValue && !R.changed(key) ? info.value + '   (saved — type to replace)' : setting.placeholder || (setting.default ? 'Default: ' + setting.default : ''),
            value,
            oninput: (e) => R.setValue(key, e.target.value),
        });
        if (!secret) return input;
        return h('div', { class: 'row' }, input,
            R.button(S.reveal[key] ? 'Hide' : 'Show', { size: 'sm', icon: S.reveal[key] ? 'eyeOff' : 'eye', disabled: locked, onClick: async () => {
                S.reveal[key] = !S.reveal[key];
                // A saved value is fetched only when asked for
                if (S.reveal[key] && info.hasValue && !R.changed(key) && S.revealed[key] === undefined) {
                    const r = await R.api('POST', '/reveal', R.payload({ key }));
                    S.revealed[key] = r.value || '';
                }
                R.render();
            } }),
            setting.generate ? R.button('Generate', { size: 'sm', icon: 'refresh', disabled: locked, onClick: () => {
                S.reveal[key] = true;
                R.setValue(key, randomSecret());
                R.render();
            } }) : null);
    };

    R.field = (setting) => {
        const info = R.info(setting.key);
        const required = S.validation && S.validation.required.includes(setting.key);
        const meta = [];
        if (info.locked) meta.push(R.badge('Set by the environment — change it there', 'warn', 'lock'));
        else if (R.changed(setting.key)) {
            const generated = S.state.suggested[setting.key] && S.changes[setting.key] === S.state.suggested[setting.key];
            meta.push(R.badge(generated ? 'Generated — saved with the setup' : 'Changed', 'brand'));
        } else if (info.source === 'file') meta.push(R.badge('Saved in ' + S.state.envFile.display));
        if (setting.default && !info.locked) meta.push(R.badge('Default: ' + setting.default, 'outline'));
        return h('div', { class: 'field' + (R.changed(setting.key) ? ' changed' : ''), 'data-key': setting.key },
            h('div', null,
                h('label', { class: 'name', for: 'f-' + setting.key }, setting.label, required ? h('span', { class: 'req', title: 'Required', text: '*' }) : null),
                h('span', { class: 'key', text: setting.key })),
            h('div', null, R.fieldInput(setting),
                setting.help ? h('div', { class: 'help', text: setting.help }) : null,
                meta.length ? h('div', { class: 'meta' }, meta) : null,
                h('div', { class: 'msg', 'data-msg': setting.key })));
    };

    R.updateMessages = () => {
        if (!S.validation) return;
        for (const el of document.querySelectorAll('[data-msg]')) {
            const key = el.getAttribute('data-msg');
            const error = S.validation.errors[key];
            const warning = S.validation.warnings[key];
            el.className = 'msg ' + (error ? 'error' : warning ? 'warning' : '');
            el.replaceChildren();
            if (error || warning) R.append(el, [R.icon('alert'), h('span', { text: error || warning })]);
            const input = document.getElementById('f-' + key);
            if (input && input.classList) input.classList.toggle('invalid', !!error);
        }
        for (const el of document.querySelectorAll('.field[data-key]')) el.classList.toggle('changed', R.changed(el.getAttribute('data-key')));
    };

    /** The connection test of a section (database, redis, ldap, oidc, webdav) */
    R.checkPanel = (section) => {
        const name = section.check;
        const withLogin = name === 'ldap' || name === 'webdav';
        const ui = S.ui['check-' + name] || (S.ui['check-' + name] = { user: '', pass: '' });
        return h('div', { style: { padding: '14px 0 16px', borderTop: '1px solid var(--border)' } },
            withLogin ? h('div', { class: 'row', style: { marginBottom: '8px' } },
                h('input', { class: 'input', type: 'text', placeholder: 'Test user (optional)', autocomplete: 'off', id: 'chk-user-' + name, value: ui.user, oninput: (e) => { ui.user = e.target.value; } }),
                h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'off', id: 'chk-pass-' + name, value: ui.pass, oninput: (e) => { ui.pass = e.target.value; } })) : null,
            h('div', { class: 'row' },
                R.button('Test connection', { icon: 'play', busy: 'Testing…', onClick: async () => {
                    S.checks[section.id] = await R.api('POST', '/check/' + name, R.payload(withLogin ? { username: ui.user || undefined, password: ui.pass || undefined } : {}));
                    R.render();
                } }),
                withLogin ? h('span', { class: 'muted small', text: 'With a test user, the sign-in itself is tried and the identity shown. Nothing is stored.' }) : null),
            R.result(S.checks[section.id]));
    };

    /** A settings section as a card: its fields, advanced ones folded, and its connection test */
    R.sectionCard = (section, o) => {
        o = o || {};
        const v = S.validation;
        const shown = section.settings.filter((s) => !v || v.visible.includes(s.key));
        if (shown.length === 0) return null;
        // An optional section nobody uses yet stays folded until asked for
        if (o.optional && !S.ui['open-' + section.id] && !shown.some((s) => R.hasValue(s.key) || R.error(s.key))) {
            return R.card({ id: 'section-' + section.id, title: o.title || section.title, description: o.description === undefined ? section.description : o.description,
                actions: [R.button(o.optional, { size: 'sm', icon: 'plus', onClick: () => { S.ui['open-' + section.id] = true; R.render(); } })] });
        }
        const basic = shown.filter((s) => !s.advanced);
        const advanced = shown.filter((s) => s.advanced);
        const open = S.ui['adv-' + section.id] || advanced.some((s) => R.changed(s.key) || (v && v.errors[s.key]));
        const state = R.sectionState(section);
        return R.card({
            id: 'section-' + section.id,
            title: o.title || section.title,
            description: o.description === undefined ? section.description : o.description,
            badge: state === 'bad' ? R.badge('Needs attention', 'bad') : null,
            actions: o.actions,
        },
        basic.map(R.field),
        advanced.length ? h('div', { style: { padding: '10px 0 14px', borderTop: basic.length ? '1px solid var(--border)' : '0' } },
            R.button((open ? 'Hide' : 'Show') + ' advanced settings (' + advanced.length + ')', { kind: 'ghost', size: 'sm', icon: open ? 'chevronDown' : 'chevronRight',
                onClick: () => { S.ui['adv-' + section.id] = !open; R.render(); } })) : null,
        open ? advanced.map(R.field) : null,
        section.check && o.check !== false ? R.checkPanel(section) : null);
    };

    // ── Editors ──────────────────────────────────────────────────────────
    /** Name → text pairs (headers, query parameters) */
    R.kvEditor = (pairs, onChange, o) => {
        o = o || {};
        const entries = Object.entries(pairs || {});
        const set = (list) => onChange(Object.fromEntries(list.filter(([k]) => k !== '')));
        const rows = entries.map(([k, val], i) => [
            h('input', { class: 'input sm mono', value: k, placeholder: o.keyLabel || 'Name', 'aria-label': o.keyLabel || 'Name', id: (o.id || 'kv') + '-k' + i,
                onchange: (e) => { const list = entries.slice(); list[i] = [e.target.value.trim(), val]; set(list); } }),
            h('input', { class: 'input sm mono', value: val, placeholder: o.valueLabel || 'Value', 'aria-label': o.valueLabel || 'Value', id: (o.id || 'kv') + '-v' + i,
                onchange: (e) => { const list = entries.slice(); list[i] = [k, e.target.value]; set(list); } }),
            R.button('', { kind: 'ghost', size: 'xs', icon: 'trash', aria: 'Remove', onClick: () => set(entries.filter((_, j) => j !== i)) }),
        ]);
        const add = h('div', { class: 'row', style: { marginTop: entries.length ? '8px' : 0 } },
            R.button(o.addLabel || 'Add', { size: 'xs', icon: 'plus', onClick: () => {
                let n = 1;
                let name = o.newKey || 'Name';
                while (Object.prototype.hasOwnProperty.call(pairs || {}, name)) name = (o.newKey || 'Name') + '-' + ++n;
                onChange(Object.assign({}, pairs || {}, { [name]: '' }));
            } }));
        return h('div', null, entries.length ? h('div', { class: 'kv' }, h('div', { class: 'head', text: o.keyLabel || 'Name' }), h('div', { class: 'head', text: o.valueLabel || 'Value' }), h('div'), rows) : null, add);
    };

    const REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/;
    R.envRef = (text) => {
        const m = REF.exec(text || '');
        return m ? { name: m[1], fallback: m[2] } : null;
    };
    /**
     * A credential in config/app.json, kept in the environment: the file holds ${NAME}, the
     * value is saved as the setting NAME. A value written into the file can be moved there.
     */
    R.secretRef = (value, suggest, onChange, o) => {
        o = o || {};
        const ref = R.envRef(value);
        const id = o.id || 'ref-' + suggest;
        if (!ref && value) {
            return h('div', null,
                h('div', { class: 'row' }, h('input', { class: 'input mono', id, type: 'password', value, autocomplete: 'off', oninput: (e) => onChange(e.target.value) })),
                h('div', { class: 'msg warning' }, R.icon('alert'), h('span', null, 'Saved in config/app.json as plain text. ',
                    h('a', { href: '#', onclick: (e) => { e.preventDefault(); R.setValue(suggest, value); onChange('${' + suggest + '}'); R.render(); } }, 'Keep it in the environment as ' + suggest))));
        }
        const name = ref ? ref.name : suggest;
        const info = R.info(name);
        const current = R.changed(name) ? S.changes[name] : '';
        return h('div', null,
            h('div', { class: 'with-addon' },
                h('span', { class: 'addon mono', title: 'Environment variable', text: '$' }),
                h('input', { class: 'input mono', style: { maxWidth: '240px' }, value: name, 'aria-label': 'Environment variable', id: id + '-name',
                    onchange: (e) => {
                        const next = e.target.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                        if (!next) return;
                        if (R.changed(name)) { R.setValue(next, S.changes[name]); delete S.changes[name]; }
                        onChange('${' + next + (ref && ref.fallback !== undefined ? ':-' + ref.fallback : '') + '}');
                        R.render();
                    } }),
                h('input', { class: 'input mono', id, type: S.reveal[name] ? 'text' : 'password', autocomplete: 'new-password', value: current,
                    placeholder: info.hasValue ? info.value + '   (saved — type to replace)' : ref && ref.fallback ? 'Default in the file: ' + ref.fallback : 'Value',
                    oninput: (e) => {
                        R.setValue(name, e.target.value);
                        if (!ref) onChange('${' + name + '}');
                    } })),
            h('div', { class: 'help', style: { fontSize: '12.5px', color: 'var(--text-3)', marginTop: '5px' } },
                'config/app.json references ', h('code', { text: '${' + name + '}' }), '; the value is saved with the settings' + (info.locked ? ' — it is set by the environment.' : '.')));
    };

    // ── Diff ─────────────────────────────────────────────────────────────
    /** Line diff (LCS) with context — for the review of changed files */
    R.diff = (before, after) => {
        const a = (before || '').replace(/\n$/, '').split('\n');
        const b = (after || '').replace(/\n$/, '').split('\n');
        if (before === null || before === undefined || before === '') {
            return h('div', { class: 'diff' }, b.map((line) => h('div', { class: 'add' }, h('span', { class: 'sign', text: '+' }), line)));
        }
        if (a.length * b.length > 4000000) return h('pre', { class: 'code light', text: after });
        const n = a.length;
        const m = b.length;
        const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        const ops = [];
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
            else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push(['+', b[j]]); j++; }
            else { ops.push(['-', a[i]]); i++; }
        }
        const keep = ops.map((op, k) => op[0] !== ' ' || ops.slice(Math.max(0, k - 3), k + 4).some((x) => x[0] !== ' '));
        const lines = [];
        let skipped = 0;
        ops.forEach((op, k) => {
            if (!keep[k]) { skipped++; return; }
            if (skipped) { lines.push(h('div', { class: 'gap', text: '⋯ ' + skipped + ' unchanged line' + (skipped === 1 ? '' : 's') })); skipped = 0; }
            lines.push(h('div', { class: op[0] === '+' ? 'add' : op[0] === '-' ? 'del' : '' }, h('span', { class: 'sign', text: op[0] === ' ' ? '' : op[0] }), op[1]));
        });
        if (skipped) lines.push(h('div', { class: 'gap', text: '⋯ ' + skipped + ' unchanged line' + (skipped === 1 ? '' : 's') }));
        return h('div', { class: 'diff' }, lines);
    };
    R.diffStats = (before, after) => {
        const a = (before || '').split('\n');
        const b = (after || '').split('\n');
        const count = (list) => list.reduce((map, line) => map.set(line, (map.get(line) || 0) + 1), new Map());
        const ca = count(a);
        const cb = count(b);
        let added = 0;
        let removed = 0;
        for (const [line, c] of cb) added += Math.max(0, c - (ca.get(line) || 0));
        for (const [line, c] of ca) removed += Math.max(0, c - (cb.get(line) || 0));
        return { added, removed };
    };

    /** A raw JSON editor for a config file, with its problems */
    R.jsonEditor = (id, help) => {
        const problems = S.fileProblems[id] || [];
        return h('div', null,
            help ? h('p', { class: 'muted', style: { marginTop: 0 }, text: help }) : null,
            h('textarea', { class: 'input tall', id: 'json-' + id, spellcheck: 'false', value: R.fileText(id) || '', 'aria-label': R.fileTitles[id],
                oninput: (e) => R.setFileText(id, e.target.value) }),
            problems.length ? R.notice('bad', 'Problems in ' + R.fileTitles[id], h('ul', null, problems.map((p) => h('li', { text: p })))) : null);
    };

    /** Problems of a staged file, shown above its editor */
    R.fileNotice = (id) => {
        const problems = S.fileProblems[id] || [];
        if (R.fileJson(id, {}) === null) {
            return R.notice('bad', R.fileTitles[id] + ' is not valid JSON', 'Fix it in the JSON view — the editor needs a valid file.',
                [R.button('Open the JSON view', { size: 'sm', icon: 'code', onClick: () => { S.ui['json-' + id] = true; R.render(); } })]);
        }
        return problems.length ? R.notice('bad', 'Problems in ' + R.fileTitles[id], h('ul', null, problems.map((p) => h('li', { text: p })))) : null;
    };

    R.fileBadge = (id) => (R.fileDirty(id) ? R.badge('Unsaved', 'brand') : S.files[id] && S.files[id].original !== null ? R.badge(R.fileTitles[id], 'outline', 'file') : R.badge('New file: ' + R.fileTitles[id], 'outline', 'file'));
}

// @ts-nocheck — browser code. Each install function is serialized with Function.toString into
// the wizard page (see ./index.ts): no imports, no references outside the function.

/**
 * The wizard's runtime: state, API access, routing, the application shell (top bar,
 * navigation, unsaved-changes bar), toasts and dialogs. Pages register themselves with
 * R.page(...) and render from R.S.
 */
export function installCore(R) {
    const S = (R.S = {
        state: null,
        /** Env changes: key → value ('' removes the key) */
        changes: {},
        /** Config files: id → { original: text | null, text?: staged text } */
        files: {},
        validation: null,
        fileProblems: {},
        visible: {},
        page: 'overview',
        sub: null,
        revealed: {},
        reveal: {},
        checks: {},
        project: null,
        acl: null,
        rls: null,
        admin: null,
        ui: {},
    });
    R.pages = [];
    R.byId = {};

    // ── DOM ──────────────────────────────────────────────────────────────
    function append(el, children) {
        for (const c of children) {
            if (c === null || c === undefined || c === false || c === true) continue;
            if (Array.isArray(c)) append(el, c);
            else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
        }
    }
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        let value;
        if (attrs) {
            for (const k in attrs) {
                const v = attrs[k];
                if (v === undefined || v === null || v === false) continue;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k === 'value') value = v;
                else if (k === 'checked') el.checked = !!v;
                else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
                else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else el.setAttribute(k, v === true ? '' : String(v));
            }
        }
        append(el, children);
        // After the children: a select needs its options before it takes a value
        if (value !== undefined) el.value = value;
        return el;
    }
    R.h = h;
    R.append = append;

    const ICONS = {
        home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
        database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
        layers: 'M12 3l9 5-9 5-9-5 9-5z M3 12.5l9 5 9-5 M3 17l9 5 9-5',
        key: 'M14.5 3.5a6 6 0 0 0-5.8 7.6L3 16.8V21h4.2l1-1v-2h2v-2h2l1.1-1.1A6 6 0 1 0 14.5 3.5z M16.5 7.5h.01',
        user: 'M20 21a8 8 0 0 0-16 0 M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
        shield: 'M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z M9 12l2 2 4-4',
        lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
        gauge: 'M4 18a8 8 0 1 1 16 0 M12 18l3.5-5.5 M12 18h.01',
        plug: 'M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4',
        sliders: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5v4 M9 15v4',
        flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
        check: 'M5 12.5l4.5 4.5L19 7',
        x: 'M6 6l12 12 M18 6L6 18',
        alert: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
        info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 11v6 M12 7.5h.01',
        plus: 'M12 5v14 M5 12h14',
        trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
        refresh: 'M20 11a8 8 0 0 0-14.9-3 M4 4v4h4 M4 13a8 8 0 0 0 14.9 3 M20 20v-4h-4',
        copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
        eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
        eyeOff: 'M3 3l18 18 M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.3 3.9 M6.2 7.6A17 17 0 0 0 2 12s4 6 10 6a9.6 9.6 0 0 0 4.4-1.1 M9.9 9.9a3 3 0 0 0 4.2 4.2',
        search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
        chevronRight: 'M9 6l6 6-6 6',
        chevronDown: 'M6 9l6 6 6-6',
        chevronLeft: 'M15 6l-6 6 6 6',
        sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
        moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
        play: 'M7 4l13 8-13 8z',
        external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
        code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6',
        send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4z',
        book: 'M4 4h6a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4z M20 4h-4a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h5z',
        terminal: 'M4 17l6-5-6-5 M12 19h8',
        file: 'M14 3H6v18h12V7z M14 3v4h4',
        server: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01',
        menu: 'M4 6h16 M4 12h16 M4 18h16',
        edit: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
        undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
        download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
        dots: 'M5 12h.01 M12 12h.01 M19 12h.01',
        globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
    };
    R.icon = (name, cls) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICONS[name] || ICONS.info);
        svg.appendChild(path);
        return svg;
    };

    // ── Server ───────────────────────────────────────────────────────────
    R.api = async (method, path, body) => {
        let response;
        try {
            response = await fetch('/setup/api' + path, {
                method,
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-Rapidd-Setup': '1' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (err) {
            R.toast('bad', 'The setup server does not answer — is it still running?');
            throw err;
        }
        if (response.status === 401) {
            location.href = '/setup';
            throw new Error('The setup session has ended');
        }
        const data = await response.json().catch(() => ({}));
        if (response.status >= 500 && !data.error) data.error = 'The setup server failed (' + response.status + ')';
        data.__status = response.status;
        return data;
    };
    /** The request body carrying the unsaved state */
    R.payload = (extra) => Object.assign({ changes: S.changes, files: R.stagedFiles() }, extra || {});

    // ── Settings ─────────────────────────────────────────────────────────
    R.setting = (key) => {
        for (const section of S.state.sections) for (const s of section.settings) if (s.key === key) return s;
        return null;
    };
    R.section = (id) => S.state.sections.find((s) => s.id === id) || null;
    R.info = (key) => S.state.values[key] || { value: '', hasValue: false, source: 'unset', locked: false };
    R.isSecret = (setting) => !!setting && setting.type === 'secret';
    R.changed = (key) => Object.prototype.hasOwnProperty.call(S.changes, key);
    R.value = (key) => {
        if (R.changed(key)) return S.changes[key];
        if (R.isSecret(R.setting(key))) return S.revealed[key] !== undefined ? S.revealed[key] : '';
        return R.info(key).value;
    };
    /** The value a setting has once saved — the stored one for an untouched secret */
    R.hasValue = (key) => (R.changed(key) ? S.changes[key] !== '' : R.info(key).hasValue);
    R.setValue = (key, value, rerender) => {
        const original = R.info(key);
        const secret = R.isSecret(R.setting(key));
        if (!secret && value === original.value) delete S.changes[key];
        else if (secret && S.revealed[key] !== undefined && value === S.revealed[key]) delete S.changes[key];
        else if (secret && S.revealed[key] === undefined && value === '' && !S.state.suggested[key]) delete S.changes[key];
        else S.changes[key] = value;
        R.evaluateSoon(rerender || S.state.drivers.includes(key));
        R.refreshChrome();
    };

    // ── Config files (staged until saved) ────────────────────────────────
    R.fileText = (id) => {
        const f = S.files[id];
        if (!f) return null;
        return f.text !== undefined ? f.text : f.original;
    };
    R.fileDirty = (id) => !!S.files[id] && S.files[id].text !== undefined;
    /** The parsed file — `fallback` when there is none, null when it is not valid JSON */
    R.fileJson = (id, fallback) => {
        const text = R.fileText(id);
        if (text === null || text === undefined || text.trim() === '') return fallback;
        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    };
    R.setFileText = (id, text) => {
        const f = S.files[id] || (S.files[id] = { original: null });
        if (text === f.original || (f.original === null && text.trim() === '')) delete f.text;
        else f.text = text;
        R.evaluateSoon(false);
        R.refreshChrome();
    };
    R.setFileJson = (id, value) => {
        const f = S.files[id] || (S.files[id] = { original: null });
        // Unchanged in content: keep the file as it is (its formatting included)
        try {
            if (f.original !== null && JSON.stringify(JSON.parse(f.original)) === JSON.stringify(value)) {
                delete f.text;
                R.evaluateSoon(false);
                R.refreshChrome();
                return;
            }
        } catch {
            // the saved file is not valid JSON — replaced
        }
        R.setFileText(id, JSON.stringify(value, null, 4) + '\n');
    };
    R.discardFile = (id) => {
        if (S.files[id]) delete S.files[id].text;
        R.evaluateSoon(true);
    };
    R.stagedFiles = () => {
        const out = {};
        for (const id in S.files) if (R.fileDirty(id)) out[id] = S.files[id].text;
        return out;
    };
    R.fileTitles = { app: 'config/app.json', rateLimit: 'config/rate-limit.json', acl: 'config/acl.json', rls: 'config/rls.json' };
    /** npm run setup ends with saving; at boot, finishing starts the API */
    R.command = () => S.state.mode === 'setup';
    R.finishTitle = () => (R.command() ? 'Review & finish' : 'Review & start');

    /** Untouched generated secrets are not counted: they are saved with the setup anyway */
    R.generated = (key) => !!S.state.suggested[key] && S.changes[key] === S.state.suggested[key];
    R.unsaved = () => ({ settings: Object.keys(S.changes).filter((k) => !R.generated(k)).length, files: Object.keys(R.stagedFiles()).length });
    /** Settings a save writes: generated secrets of settings that do not apply are left out (the server does the same) */
    R.pendingKeys = () => Object.keys(S.changes).filter((k) => !(R.generated(k) && S.validation && !S.validation.visible.includes(k)));

    // ── Validation ───────────────────────────────────────────────────────
    let timer = null;
    let pendingRender = false;
    let sequence = 0;
    R.evaluateSoon = (rerender) => {
        pendingRender = pendingRender || !!rerender;
        clearTimeout(timer);
        timer = setTimeout(R.evaluate, pendingRender ? 120 : 350);
    };
    R.evaluate = async () => {
        clearTimeout(timer);
        const mine = ++sequence;
        const r = await R.api('POST', '/evaluate', R.payload());
        if (mine !== sequence || !r.validation) return;
        S.validation = r.validation;
        S.proxy = r.proxy || null;
        S.fileProblems = r.fileProblems || {};
        if (r.sections.length && r.sections[0].settings) S.state.sections = r.sections;
        for (const s of r.sections) S.visible[s.id] = s.visible;
        const rerender = pendingRender;
        pendingRender = false;
        if (rerender) R.render();
        else {
            R.updateMessages();
            R.refreshChrome();
        }
    };
    R.error = (key) => (S.validation && S.validation.errors[key]) || null;
    R.visibleKeys = (section) => section.settings.map((s) => s.key).filter((k) => !S.validation || S.validation.visible.includes(k));
    /** ok / bad / '' for a settings section */
    R.sectionState = (section) => {
        if (S.visible[section.id] === false) return '';
        const keys = R.visibleKeys(section);
        if (keys.some((k) => R.error(k))) return 'bad';
        if (S.checks[section.id] && !S.checks[section.id].ok) return 'warn';
        if (S.checks[section.id] && S.checks[section.id].ok) return 'ok';
        return keys.some((k) => R.hasValue(k)) ? 'ok' : '';
    };
    R.groupState = (ids) => {
        const states = ids.map((id) => R.section(id)).filter(Boolean).map(R.sectionState);
        if (states.includes('bad')) return 'bad';
        if (states.includes('warn')) return 'warn';
        return states.includes('ok') ? 'ok' : '';
    };

    // ── Routing ──────────────────────────────────────────────────────────
    R.page = (def) => {
        R.pages.push(def);
        R.byId[def.id] = def;
    };
    function readHash() {
        const m = /^#\/?([\w-]+)(?:\/(.+))?$/.exec(location.hash);
        S.page = m && R.byId[m[1]] ? m[1] : 'overview';
        S.sub = m && m[2] ? decodeURIComponent(m[2]) : null;
    }
    R.go = (id, sub) => {
        S.page = id;
        S.sub = sub || null;
        const hash = '#/' + id + (sub ? '/' + encodeURIComponent(sub) : '');
        if (location.hash !== hash) history.pushState(null, '', hash);
        R.render();
        window.scrollTo(0, 0);
        sidebar.classList.remove('open');
        const page = R.byId[id];
        if (page && page.enter) page.enter();
    };
    // Back / forward and edited addresses: the page loads what it needs, as on a click
    window.addEventListener('popstate', () => {
        readHash();
        R.render();
        const page = R.byId[S.page];
        if (page && page.enter) page.enter();
    });

    // ── Shell ────────────────────────────────────────────────────────────
    const app = document.getElementById('app');
    const topbar = h('header', { class: 'topbar' });
    const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Setup' });
    const main = h('main', { id: 'main', tabindex: '-1' });
    const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    const savebarHost = h('div');
    R.main = main;

    function effectiveTheme() {
        const set = document.documentElement.getAttribute('data-theme');
        if (set) return set;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try {
            localStorage.setItem('rapidd-setup-theme', theme);
        } catch {
            // storage unavailable: the choice lasts for this page
        }
        renderTop();
    }
    try {
        const saved = localStorage.getItem('rapidd-setup-theme');
        if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    } catch {
        // system theme
    }

    function renderTop() {
        if (!S.state) return;
        const st = S.state;
        const ready = st.reasons.length === 0;
        topbar.replaceChildren(
            h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', onclick: () => sidebar.classList.toggle('open') }, R.icon('menu', 'lg')),
            h('a', { class: 'brand', href: '#/overview', onclick: (e) => { e.preventDefault(); R.go('overview'); } },
                h('img', { src: '/setup/assets/logo.png', alt: '' }), 'Rapidd', h('span', { class: 'product', text: 'Setup' })),
            h('span', { class: 'project' }, h('b', { text: st.app.name }), st.app.version ? ' ' + st.app.version : ''),
            h('span', { class: 'spacer' }),
            h('span', { class: 'pill ' + (ready ? 'ready' : 'setup'), title: ready ? 'The API can start' : st.reasons.map((r) => r.key + ': ' + r.message).join('\n') },
                h('span', { class: 'dot' }), h('span', { class: 'label', text: ready ? 'Ready to start' : 'Setup required' })),
            h('span', { class: 'envfile', title: st.envFile.path, text: st.envFile.display }),
            h('a', { class: 'icon-btn', href: 'https://github.com/MertDalbudak/rapidd/wiki', target: '_blank', rel: 'noopener noreferrer', title: 'Documentation', 'aria-label': 'Documentation' }, R.icon('book', 'lg')),
            h('button', { class: 'icon-btn', title: 'Switch theme', 'aria-label': 'Switch between light and dark theme',
                onclick: () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark') }, R.icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', 'lg')));
    }

    function stateMark(state) {
        if (!state) return null;
        return h('span', { class: 'state ' + state, title: state === 'ok' ? 'Done' : state === 'bad' ? 'Needs attention' : 'Check this' },
            R.icon(state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'alert'));
    }

    function renderNav() {
        if (!S.state) return;
        const nodes = [];
        let group = null;
        for (const page of R.pages) {
            if (page.hidden || page.id === 'review') continue;
            if (page.group !== group) {
                group = page.group;
                if (group) nodes.push(h('div', { class: 'nav-group', text: group }));
            }
            let state = '';
            try {
                state = page.status ? page.status() : '';
            } catch {
                state = '';
            }
            const count = page.count ? page.count() : 0;
            nodes.push(h('button', {
                class: 'nav-item' + (S.page === page.id ? ' active' : ''),
                'aria-current': S.page === page.id ? 'page' : null,
                onclick: () => R.go(page.id),
            }, R.icon(page.icon), h('span', { class: 'label', text: page.title }), count ? h('span', { class: 'count', text: String(count) }) : stateMark(state)));
        }
        const unsaved = R.unsaved();
        const total = unsaved.settings + unsaved.files;
        nodes.push(h('div', { class: 'grow' }));
        nodes.push(h('div', { class: 'finish' },
            h('button', { class: 'btn primary block' + (S.page === 'review' ? ' active' : ''), onclick: () => R.go('review') },
                R.icon('flag'), R.finishTitle(), total ? h('span', { class: 'count', style: { background: 'rgba(255,255,255,.25)', borderRadius: '99px', padding: '0 7px', fontSize: '12px' }, text: String(total) }) : null)));
        sidebar.replaceChildren(...nodes);
    }

    function renderSavebar() {
        if (!S.state) return;
        const unsaved = R.unsaved();
        const total = unsaved.settings + unsaved.files;
        if (!total || S.page === 'review') {
            savebarHost.replaceChildren();
            return;
        }
        const parts = [];
        if (unsaved.settings) parts.push(unsaved.settings + ' setting' + (unsaved.settings === 1 ? '' : 's'));
        if (unsaved.files) parts.push(unsaved.files + ' file' + (unsaved.files === 1 ? '' : 's'));
        savebarHost.replaceChildren(h('div', { class: 'savebar', role: 'region', 'aria-label': 'Unsaved changes' },
            R.icon('info'),
            h('div', { class: 'text' }, h('b', { text: 'Unsaved changes' }), h('span', { text: parts.join(' · ') })),
            R.button('Discard', { kind: 'ghost', size: 'sm', onClick: R.discardAll }),
            R.button('Review & save', { kind: 'primary', size: 'sm', icon: 'chevronRight', onClick: () => R.go('review') })));
    }

    R.discardAll = async () => {
        const ok = await R.confirm({ title: 'Discard all changes?', text: 'Every unsaved setting and file change is dropped. Saved configuration stays as it is.', confirm: 'Discard', danger: true });
        if (!ok) return;
        S.changes = {};
        for (const k in S.state.suggested) if (!S.state.values[k] || !S.state.values[k].hasValue) S.changes[k] = S.state.suggested[k];
        for (const id in S.files) delete S.files[id].text;
        S.revealed = {};
        await R.evaluate();
        R.render();
    };

    R.refreshChrome = () => {
        renderTop();
        renderNav();
        renderSavebar();
    };

    R.render = () => {
        if (!S.state) return;
        // Keep focus and caret when the page is drawn again (e.g. after validation)
        const active = document.activeElement;
        const focusId = active && active.id && main.contains(active) ? active.id : null;
        const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
        renderTop();
        renderNav();
        const page = R.byId[S.page] || R.byId.overview;
        const content = h('div', { class: 'page' });
        try {
            append(content, page.render());
        } catch (err) {
            console.error(err);
            append(content, R.notice('bad', 'This page could not be shown', String((err && err.message) || err)));
        }
        main.replaceChildren(content);
        renderSavebar();
        R.updateMessages();
        if (focusId) {
            const el = document.getElementById(focusId);
            if (el && el !== document.activeElement) {
                el.focus();
                if (caret && el.setSelectionRange) {
                    try {
                        el.setSelectionRange(caret[0], caret[1]);
                    } catch {
                        // not a text input
                    }
                }
            }
        }
    };

    // ── Feedback ─────────────────────────────────────────────────────────
    R.toast = (kind, text, ms) => {
        const el = h('div', { class: 'toast ' + kind, role: kind === 'bad' ? 'alert' : 'status' },
            R.icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert'),
            h('div', { class: 'body' }, text),
            h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Dismiss', onclick: () => el.remove() }, R.icon('x')));
        toasts.appendChild(el);
        setTimeout(() => el.remove(), ms || (kind === 'bad' ? 9000 : 4500));
    };

    /**
     * A modal dialog. `render(d)` returns { body, actions } and runs again on d.update().
     * Escape and the backdrop close it.
     */
    R.dialog = (o) => {
        const previous = document.activeElement;
        const bodyEl = h('div', { class: 'dialog-body' });
        const foot = h('div', { class: 'dialog-foot' });
        const titleEl = h('h2', { text: o.title });
        const d = {};
        const onKey = (e) => {
            if (e.key === 'Escape') d.close();
        };
        const dialogEl = h('div', { class: 'dialog' + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
            h('div', { class: 'dialog-head' }, titleEl, h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => d.close() }, R.icon('x'))),
            bodyEl, foot);
        const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop) d.close(); } }, dialogEl);
        d.close = () => {
            backdrop.remove();
            document.removeEventListener('keydown', onKey);
            if (previous && previous.focus && previous.isConnected) previous.focus();
            if (o.onClose) o.onClose();
        };
        d.update = () => {
            const active = document.activeElement;
            const focusId = active && active.id && dialogEl.contains(active) ? active.id : null;
            const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
            const out = o.render(d) || {};
            bodyEl.replaceChildren();
            append(bodyEl, [out.body]);
            foot.replaceChildren();
            append(foot, [out.actions]);
            foot.style.display = out.actions ? '' : 'none';
            if (focusId) {
                const el = document.getElementById(focusId);
                if (el) {
                    el.focus();
                    if (caret && el.setSelectionRange) {
                        try {
                            el.setSelectionRange(caret[0], caret[1]);
                        } catch {
                            // not a text input
                        }
                    }
                }
            }
        };
        d.setTitle = (t) => { titleEl.textContent = t; };
        d.update();
        document.body.appendChild(backdrop);
        document.addEventListener('keydown', onKey);
        const first = dialogEl.querySelector('.dialog-body input:not([type=checkbox]), .dialog-body select, .dialog-body textarea') || dialogEl.querySelector('.dialog-foot .btn.primary');
        if (first) first.focus();
        return d;
    };

    R.confirm = (o) => new Promise((resolve) => {
        let answered = false;
        const d = R.dialog({
            title: o.title,
            onClose: () => { if (!answered) resolve(false); },
            render: () => ({
                body: [o.text ? h('p', { style: { margin: 0 }, text: o.text }) : null, o.body || null],
                actions: [
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button(o.confirm || 'Continue', { kind: o.danger ? 'danger solid' : 'primary', onClick: () => { answered = true; resolve(true); d.close(); } }),
                ],
            }),
        });
    });

    // ── Start ────────────────────────────────────────────────────────────
    /** Fresh state from the server; staged changes are kept */
    R.reload = async () => {
        const st = await R.api('GET', '/state');
        if (st.__status >= 400) throw new Error(st.error || 'The setup state could not be loaded');
        S.state = st;
        for (const id of Object.keys(st.files)) {
            const previous = S.files[id];
            S.files[id] = { original: st.files[id] };
            if (previous && previous.text !== undefined && previous.text !== st.files[id]) S.files[id].text = previous.text;
        }
        for (const k in st.suggested) if (!R.changed(k)) S.changes[k] = st.suggested[k];
        for (const s of st.sections) S.visible[s.id] = s.visible;
        S.validation = st.validation;
        S.proxy = st.proxy || null;
        await R.evaluate();
        R.render();
    };

    R.start = async () => {
        app.replaceChildren(topbar, h('div', { class: 'shell' }, sidebar, main), savebarHost, toasts);
        main.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spin' }), 'Loading the configuration…'));
        readHash();
        try {
            await R.reload();
        } catch (err) {
            main.replaceChildren(R.notice('bad', 'The setup could not be loaded', String((err && err.message) || err)));
            return;
        }
        const page = R.byId[S.page];
        if (page && page.enter) page.enter();
        window.addEventListener('beforeunload', (e) => {
            const unsaved = R.unsaved();
            if (!R.finished && unsaved.settings + unsaved.files > 0) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    };
}

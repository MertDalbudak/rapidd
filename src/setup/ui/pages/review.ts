// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Review & start: every change before it is written, the export, and the handover to the API */
export function installReviewPage(R) {
    const h = R.h;
    const S = R.S;
    const FILE_PAGES = { app: 'services', rateLimit: 'ratelimits', rls: 'rls' };

    /**
     * invalid: changes and files that cannot be saved (block saving); missing: settings that are
     * not changed but keep the API from starting (block starting it, not saving)
     */
    function problems() {
        const v = S.validation;
        const invalid = [];
        const missing = [];
        for (const key of Object.keys(v.errors)) {
            const setting = R.setting(key);
            (R.changed(key) ? invalid : missing).push(h('li', null,
                h('a', { href: '#', onclick: (e) => { e.preventDefault(); R.fix(key); } }, setting ? setting.label : key), h('span', { class: 'muted', text: ' (' + key + ')' }), ' — ' + v.errors[key]));
        }
        for (const [id, list] of Object.entries(S.fileProblems)) {
            for (const p of list) invalid.push(h('li', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); R.go(FILE_PAGES[id]); } }, R.fileTitles[id]), ' — ' + p));
        }
        return { invalid, missing };
    }

    function settingsCard() {
        const keys = R.pendingKeys();
        if (!keys.length) return null;
        return R.card({ title: 'Settings', icon: 'sliders', badge: R.badge(String(keys.length), 'brand'), description: 'Written to ' + S.state.envFile.display + ' — the previous version is kept as ' + S.state.envFile.display + '.bak.', body: 'flush' },
            h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Setting', 'Before', 'After', ''].map((t) => h('th', { text: t })))),
                h('tbody', null, keys.sort().map((key) => {
                    const setting = R.setting(key);
                    const secret = R.isSecret(setting);
                    const info = R.info(key);
                    const value = S.changes[key];
                    const generated = R.generated(key);
                    return h('tr', null,
                        h('td', null, h('b', { text: setting ? setting.label : key }), h('div', { class: 'sub mono', text: key })),
                        h('td', { class: 'mono small' }, info.hasValue ? info.value : h('span', { class: 'faint', text: 'not set' })),
                        h('td', { class: 'mono small' }, value === '' ? R.badge('removed', 'warn') : secret ? h('span', null, '••••••••', generated ? R.badge('generated', 'brand') : null) : value),
                        h('td', { class: 'shrink' }, R.button('', { kind: 'ghost', size: 'sm', icon: 'undo', aria: 'Undo', title: 'Undo', onClick: () => { delete S.changes[key]; R.evaluateSoon(true); R.refreshChrome(); } })));
                })))));
    }

    function fileCards() {
        return Object.keys(R.stagedFiles()).map((id) => {
            const before = S.files[id].original;
            const after = S.files[id].text;
            const stats = R.diffStats(before, after);
            return R.card({
                title: R.fileTitles[id], icon: 'file',
                badge: h('span', { class: 'row', style: { gap: '6px' } }, R.badge('+' + stats.added, 'ok'), R.badge('−' + stats.removed, 'bad'), before === null ? R.badge('new file', 'brand') : null),
                actions: [
                    R.button('Edit', { size: 'sm', kind: 'ghost', icon: 'edit', onClick: () => R.go(FILE_PAGES[id]) }),
                    R.button('Discard', { size: 'sm', kind: 'ghost', icon: 'undo', onClick: () => R.discardFile(id) }),
                ],
            }, h('div', { style: { padding: '14px 0' } }, R.diff(before, after)));
        });
    }

    function exportCard() {
        const format = S.ui.exportFormat || 'env';
        return R.card({ title: 'Export', icon: 'download', description: 'The complete configuration including these changes — for compose files, Kubernetes or a secret store. Contains secrets.' },
            h('div', { style: { padding: '14px 0' } },
                h('div', { class: 'row', style: { marginBottom: '10px' } },
                    R.seg([['env', '.env'], ['compose', 'docker compose'], ['kubernetes', 'Kubernetes Secret'], ['shell', 'Shell']], S.ui.exportText ? format : '', async (v) => {
                        S.ui.exportFormat = v;
                        const r = await R.api('POST', '/export', R.payload({ format: v }));
                        S.ui.exportText = r.text;
                        R.render();
                    }, { label: 'Export format' }),
                    S.ui.exportText ? R.copyButton(() => S.ui.exportText) : null),
                S.ui.exportText ? h('pre', { class: 'code', text: S.ui.exportText }) : h('p', { class: 'muted', style: { margin: 0 }, text: 'Choose a format.' })));
    }

    async function save(finish) {
        S.ui.saveError = null;
        const r = await R.api('POST', finish ? '/finish' : '/save', R.payload());
        if (r.__status >= 400) {
            if (r.validation) S.validation = r.validation;
            if (r.fileProblems) S.fileProblems = r.fileProblems;
            S.ui.saveError = r;
            R.render();
            R.toast('bad', r.error || 'Saving failed');
            return;
        }
        if (finish) return r.exit ? closed(r) : done(r);
        const written = (r.saved.written.length + r.saved.removed.length) + ' setting' + (r.saved.written.length + r.saved.removed.length === 1 ? '' : 's') + (r.files.length ? ' and ' + r.files.join(', ') : '');
        S.changes = {};
        S.revealed = {};
        for (const id of Object.keys(r.texts)) S.files[id] = { original: r.texts[id] };
        S.project = null;
        S.rls = null;
        R.toast('ok', 'Saved ' + written);
        if (r.schema && r.schema.changed) R.toast('info', 'prisma/schema.prisma now uses ' + r.schema.to + ' (was ' + r.schema.from + ')');
        await R.reload();
    }

    /** npm run setup has ended: how to start the API */
    function closed(r) {
        R.finished = true;
        const reasons = r.reasons || [];
        document.getElementById('app').replaceChildren(h('div', { class: 'signin' }, h('div', { class: 'box', style: { maxWidth: '520px' } },
            h('div', { style: { textAlign: 'center' } },
                h('img', { src: '/setup/assets/logo.png', alt: '', style: { width: '64px', height: '64px', borderRadius: '16px' } }),
                h('h1', { style: { marginTop: '16px' }, text: 'Setup saved' }),
                h('p', { class: 'muted', text: 'The setup has ended — you can close this page.' })),
            reasons.length ? R.notice('warn', 'The API cannot start yet', h('ul', null, reasons.map((x) => h('li', null, h('code', { text: x.key }), ' — ' + x.message))))
                : h('div', null,
                    h('p', { style: { margin: '0 0 8px', fontWeight: '600' }, text: 'Start the API' }),
                    h('pre', { class: 'code', text: 'npm run dev     # development, reloads on changes\nnpm start       # production (after npm run build)' })))));
    }

    /** The wizard has handed over: wait for the API on the same port */
    function done(r) {
        R.finished = true;
        const line = h('p', { class: 'muted', text: 'Starting the API…' });
        const links = h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px' } });
        document.getElementById('app').replaceChildren(h('div', { class: 'signin' }, h('div', { class: 'box', style: { textAlign: 'center' } },
            h('img', { src: '/setup/assets/logo.png', alt: '', style: { width: '64px', height: '64px', borderRadius: '16px' } }),
            h('h1', { style: { marginTop: '16px' }, text: 'Setup complete' }),
            line,
            h('div', { class: 'loading', style: { justifyContent: 'center' }, id: 'done-wait' }, h('span', { class: 'spin' }), 'Waiting for the API'),
            links)));
        const samePort = String(r.port) === (location.port || (location.protocol === 'https:' ? '443' : '80'));
        if (!samePort) {
            line.textContent = 'The API starts on port ' + r.port + '.';
            document.getElementById('done-wait').remove();
            return;
        }
        let tries = 0;
        const poll = () => {
            fetch('/health', { cache: 'no-store' }).then((x) => x.json()).then((j) => {
                if (j.status && j.status !== 'setup') {
                    line.textContent = 'The API is running.';
                    document.getElementById('done-wait').remove();
                    links.replaceChildren(
                        h('a', { class: 'btn', href: '/health/ready', target: '_blank', rel: 'noopener' }, R.icon('check'), 'Readiness'),
                        h('a', { class: 'btn primary', href: '/', target: '_blank', rel: 'noopener' }, R.icon('external'), 'Open the API'));
                } else if (++tries < 90) setTimeout(poll, 1000);
            }).catch(() => {
                if (++tries < 90) setTimeout(poll, 1000);
                else {
                    line.textContent = 'The API did not answer — check the server console.';
                    document.getElementById('done-wait').remove();
                }
            });
        };
        setTimeout(poll, 800);
    }

    R.page({
        id: 'review', title: 'Review & start', group: null, icon: 'flag',
        render: () => {
            const v = S.validation;
            const { invalid, missing } = problems();
            // Here generated secrets count too: they are written with everything else
            const total = R.pendingKeys().length + R.unsaved().files;
            // Saving needs valid changes; starting the API needs every setting (npm run setup only saves)
            const blocked = invalid.length > 0;
            const blockedStart = blocked || (!R.command() && missing.length > 0);
            const out = [R.pageHead(R.finishTitle(), R.command()
                ? 'Everything that will be written — nothing is saved before you confirm here. Finishing saves the changes and ends npm run setup.'
                : 'Everything that will be written — nothing is saved before you confirm here. Finishing saves the changes and starts the API in this process.')];
            if (invalid.length) out.push(R.notice('bad', 'Fix these first', h('ul', null, invalid)));
            if (missing.length) {
                out.push(R.notice(R.command() ? 'warn' : 'bad', 'The API cannot start without these',
                    h('div', null, h('ul', null, missing), R.command() ? h('p', { class: 'muted small', style: { margin: '6px 0 0' }, text: 'You can save and finish anyway — set them later, here or in the environment.' }) : null)));
            }
            if (S.ui.saveError && S.ui.saveError.reasons) {
                out.push(R.notice('bad', S.ui.saveError.error, h('ul', null, S.ui.saveError.reasons.map((x) => h('li', null,
                    h('a', { href: '#', onclick: (e) => { e.preventDefault(); R.fix(x.key); } }, x.key), ' — ' + x.message)))));
            }
            const warnings = Object.keys(v.warnings);
            if (warnings.length) {
                out.push(R.notice('warn', 'Worth a look', h('ul', null, warnings.map((k) => h('li', null,
                    h('a', { href: '#', onclick: (e) => { e.preventDefault(); R.fix(k); } }, k), ' — ' + v.warnings[k])))));
            }
            if (R.value('SETUP_WIZARD') === 'on') {
                out.push(R.notice('info', 'The wizard opens at every start', 'SETUP_WIZARD=on keeps the API waiting for this wizard on each start.',
                    R.info('SETUP_WIZARD').locked ? null : [R.button('Set it back to auto', { size: 'sm', onClick: () => { R.setValue('SETUP_WIZARD', 'auto', true); } })]));
            }
            if (!total) out.push(R.card({}, R.empty('check', 'No unsaved changes', S.state.reasons.length ? 'The API still cannot start — see the overview.' : R.command() ? 'The configuration is saved.' : 'The configuration is saved. Start the API when you are ready.')));
            out.push(settingsCard(), fileCards(), exportCard());
            out.push(h('div', { class: 'card' }, h('div', { class: 'card-foot', style: { borderTop: 0, borderRadius: '12px', justifyContent: 'flex-end' } },
                h('span', { class: 'muted small', style: { marginRight: 'auto' }, text: total ? total + ' change' + (total === 1 ? '' : 's') + ' to save' : 'Nothing to save' }),
                R.button('Save', { icon: 'download', disabled: !total || blocked, busy: 'Saving…', onClick: () => save(false) }),
                R.command()
                    ? R.button(total ? 'Save and finish' : 'Finish', { kind: 'primary', icon: 'check', disabled: blocked, busy: 'Saving…', onClick: () => save(true) })
                    : R.button(total ? 'Save and start the API' : 'Start the API', { kind: 'primary', icon: 'play', disabled: blockedStart, busy: 'Starting…', onClick: () => save(true) }))));
            return out;
        },
    });
}

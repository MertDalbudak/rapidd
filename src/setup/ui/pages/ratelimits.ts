// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Rate limits: the default per client IP and per-path rules (config/rate-limit.json) */
export function installRateLimitsPage(R) {
    const h = R.h;
    const S = R.S;
    const UNITS = [['1000', 'seconds'], ['60000', 'minutes'], ['3600000', 'hours']];

    const limits = () => R.fileJson('rateLimit', {});
    function change(fn) {
        const current = limits();
        if (!current) return;
        fn(current);
        R.setFileJson('rateLimit', current);
        R.render();
    }
    /** windowMs → [amount, unit ms] in the largest whole unit */
    function windowOf(ms) {
        for (const [unit] of UNITS.slice().reverse()) if (ms && ms % Number(unit) === 0) return [ms / Number(unit), unit];
        return [ms / 1000, '1000'];
    }
    const describe = (rule) => {
        const max = rule.maxRequests !== undefined ? rule.maxRequests : Number(R.value('RATE_LIMIT_MAX_REQUESTS') || 100);
        const ms = rule.windowMs !== undefined ? rule.windowMs : Number(R.value('RATE_LIMIT_WINDOW_MS') || 900000);
        const [n, unit] = windowOf(ms);
        const label = UNITS.find((u) => u[0] === unit)[1];
        return max + ' requests per ' + (n === 1 ? label.replace(/s$/, '') : n + ' ' + label) + (rule.ignoreSuccessfulRequests ? ', failed ones only' : '');
    };
    /** The rule for a path: the longest matching prefix, else the default */
    function ruleFor(path, rules) {
        const prefix = Object.keys(rules).sort((a, b) => b.length - a.length).find((p) => path.startsWith(p));
        return prefix ? [prefix, rules[prefix]] : [null, {}];
    }

    R.page({
        id: 'ratelimits', title: 'Rate limits', group: 'Security', icon: 'gauge',
        status: () => ((S.fileProblems.rateLimit || []).length ? 'bad' : R.sectionState(R.section('ratelimit')) === 'bad' ? 'bad' : ''),
        enter: () => { if (!S.project) R.loadProject().catch(() => undefined); },
        render: () => {
            const json = !!S.ui['json-rateLimit'];
            const head = R.pageHead('Rate limits', 'Requests per client IP and time window. Paths in the list get their own limit — the longest matching prefix wins; every other path shares the default.', [
                R.fileBadge('rateLimit'),
                R.button(json ? 'Editor' : 'JSON', { icon: json ? 'gauge' : 'code', onClick: () => { S.ui['json-rateLimit'] = !json; R.render(); } }),
            ]);
            if (json || limits() === null) {
                return [head, R.fileNotice('rateLimit'), R.card({ title: 'config/rate-limit.json', icon: 'file' }, h('div', { style: { padding: '14px 0' } },
                    R.jsonEditor('rateLimit', '{ "/auth/login": { "maxRequests": 10, "windowMs": 900000, "ignoreSuccessfulRequests": true } } — path prefix → limit.')))];
            }
            const rules = limits();
            const entries = Object.entries(rules);
            const suggestions = ((S.project && S.project.routes) || ['/auth/login', '/auth/refresh', '/auth', '/api/v1']).filter((p) => !rules[p]);
            const redis = R.hasValue('REDIS_URL') || R.hasValue('REDIS_HOST');
            const test = S.ui.rateTest || '/auth/login';
            const [prefix, rule] = ruleFor(test, rules);
            return [
                head,
                R.fileNotice('rateLimit'),
                (R.value('NODE_ENV') || 'development') !== 'production'
                    ? R.notice('info', 'Enforced in production only', 'With NODE_ENV=' + (R.value('NODE_ENV') || 'development') + ' every request passes — the limits apply once NODE_ENV=production.') : null,
                R.sectionCard(R.section('ratelimit'), { title: 'Default limit', description: 'For every path without its own rule. One budget per client IP — not per path.' }),
                R.card({
                    title: 'Path rules', icon: 'gauge', body: 'flush',
                    description: redis ? 'Counted in Redis — one budget across every instance.' : 'Counted per instance in memory — configure Redis to share the budget between instances.',
                    footer: [
                        h('input', { class: 'input sm mono', id: 'rl-new', list: 'rl-paths', placeholder: '/api/v1/upload', style: { maxWidth: '260px' },
                            onkeydown: (e) => { if (e.key === 'Enter') document.getElementById('rl-add').click(); } }),
                        h('datalist', { id: 'rl-paths' }, suggestions.map((p) => h('option', { value: p }))),
                        R.button('Add rule', { size: 'sm', icon: 'plus', id: 'rl-add', onClick: () => {
                            const path = document.getElementById('rl-new').value.trim();
                            if (!path.startsWith('/')) return R.toast('bad', 'Paths start with /');
                            if (rules[path]) return R.toast('bad', 'There is a rule for ' + path + ' already');
                            change((all) => { all[path] = { maxRequests: 60, windowMs: 60000 }; });
                        } }),
                        !rules['/auth/login'] ? R.button('Protect sign-in', { size: 'sm', kind: 'ghost', icon: 'shield', title: '10 failed sign-ins per 15 minutes', onClick: () => change((all) => {
                            all['/auth/login'] = { maxRequests: 10, windowMs: 900000, ignoreSuccessfulRequests: true };
                        }) }) : null,
                    ],
                },
                entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                    h('thead', null, h('tr', null, ['Path prefix', 'Requests', 'Per', 'Count', ''].map((t) => h('th', { text: t })))),
                    h('tbody', null, entries.map(([path, r], i) => {
                        const [amount, unit] = windowOf(r.windowMs !== undefined ? r.windowMs : Number(R.value('RATE_LIMIT_WINDOW_MS') || 900000));
                        return h('tr', null,
                            h('td', null, h('input', { class: 'input sm mono', id: 'rl-path-' + i, value: path, 'aria-label': 'Path prefix', onchange: (e) => change((all) => {
                                const next = e.target.value.trim();
                                if (!next || next === path) return;
                                const ordered = Object.entries(all).map(([k, v]) => [k === path ? next : k, v]);
                                for (const k of Object.keys(all)) delete all[k];
                                for (const [k, v] of ordered) all[k] = v;
                            }) })),
                            h('td', null, h('input', { class: 'input sm', id: 'rl-max-' + i, inputmode: 'numeric', style: { maxWidth: '110px' }, 'aria-label': 'Requests', value: r.maxRequests === undefined ? '' : String(r.maxRequests),
                                placeholder: R.value('RATE_LIMIT_MAX_REQUESTS') || '100', onchange: (e) => change((all) => { const v = e.target.value.trim(); if (v === '') delete all[path].maxRequests; else all[path].maxRequests = Number(v); }) })),
                            h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                                h('input', { class: 'input sm', id: 'rl-win-' + i, inputmode: 'numeric', style: { maxWidth: '80px' }, 'aria-label': 'Window', value: String(amount),
                                    onchange: (e) => change((all) => { all[path].windowMs = Math.round(Number(e.target.value) * Number(unit)); }) }),
                                R.select(UNITS, unit, (u) => change((all) => { all[path].windowMs = amount * Number(u); }), { size: 'sm', label: 'Unit' }))),
                            h('td', null, R.seg([['all', 'Every request'], ['failed', 'Failed only']], r.ignoreSuccessfulRequests ? 'failed' : 'all',
                                (v) => change((all) => { if (v === 'failed') all[path].ignoreSuccessfulRequests = true; else delete all[path].ignoreSuccessfulRequests; }), { label: 'Count' })),
                            h('td', { class: 'shrink' }, R.button('', { kind: 'ghost', size: 'sm', icon: 'trash', aria: 'Remove ' + path, onClick: () => change((all) => { delete all[path]; }) })));
                    }))))
                    : R.empty('gauge', 'No path rules', 'Every path shares the default limit. Sign-in deserves a stricter one.')),
                R.card({ title: 'Which limit applies?', icon: 'search', compact: true },
                    h('div', { class: 'row', style: { padding: '14px 0' } },
                        h('input', { class: 'input mono', id: 'rl-test', value: test, style: { maxWidth: '320px' }, 'aria-label': 'Path', oninput: (e) => {
                            S.ui.rateTest = e.target.value;
                            const [p, r] = ruleFor(e.target.value, limits() || {});
                            document.getElementById('rl-answer').textContent = (p ? p + ' — ' : 'Default — ') + describe(r);
                        } }),
                        R.icon('chevronRight', 'faint'),
                        h('span', { id: 'rl-answer', text: (prefix ? prefix + ' — ' : 'Default — ') + describe(rule) }))),
            ];
        },
    });
}

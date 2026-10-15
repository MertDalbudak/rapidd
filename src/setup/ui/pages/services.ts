// @ts-nocheck — browser code, serialized into the wizard page (see ../index.ts).

/** Services: the external APIs the app calls with ApiClient (config/app.json → services) */
export function installServicesPage(R) {
    const h = R.h;
    const S = R.S;
    const AUTH = [['', 'None'], ['basic', 'Basic'], ['bearer', 'Bearer token'], ['api-key', 'API key'], ['oauth2', 'OAuth 2.0']];
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

    const config = () => R.fileJson('app', {});
    const services = () => { const c = config(); return (c && c.services) || {}; };
    function change(fn) {
        const c = config();
        if (!c) return;
        c.services = c.services || {};
        fn(c.services, c);
        R.setFileJson('app', c);
        R.render();
    }
    const envName = (service, suffix) => service.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + suffix;
    const baseUrl = (s) => (s.secure === false ? 'http' : 'https') + '://' + (s.hostname || '?') + (s.port ? ':' + s.port : '') + (s.path || '');
    const params = (path) => Array.from(new Set((String(path || '').match(/\{\{\s*([^}\s]+)\s*\}\}/g) || []).map((m) => m.replace(/[{}\s]/g, ''))));
    const problemsOf = (name) => (S.fileProblems.app || []).filter((p) => p.startsWith('services.' + name + '.') || p.startsWith('services.' + name + ':'));

    function parseUrl(text) {
        try {
            const u = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text);
            const out = { hostname: u.hostname, secure: u.protocol === 'https:' };
            if (u.port) out.port = Number(u.port);
            if (u.pathname && u.pathname !== '/') out.path = u.pathname.replace(/\/$/, '');
            return out;
        } catch {
            return null;
        }
    }

    function addDialog() {
        let name = '';
        let url = '';
        let error = '';
        const d = R.dialog({
            title: 'Add a service',
            render: () => ({
                body: [
                    h('div', { class: 'form-row' }, h('label', { for: 'svc-name', text: 'Name' }),
                        h('input', { class: 'input', id: 'svc-name', value: name, placeholder: 'PaymentAPI', oninput: (e) => { name = e.target.value.trim(); } }),
                        h('div', { class: 'help', text: 'Used in code: ApiClient.call(\'' + (name || 'PaymentAPI') + '\', \'endpoint\').' })),
                    h('div', { class: 'form-row' }, h('label', { for: 'svc-url', text: 'Base URL' }),
                        h('input', { class: 'input mono', id: 'svc-url', value: url, placeholder: 'https://api.example.com/v1', oninput: (e) => { url = e.target.value.trim(); } })),
                    error ? R.notice('bad', error) : null,
                ],
                actions: [
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button('Add service', { kind: 'primary', icon: 'plus', onClick: () => {
                        const parsed = parseUrl(url);
                        if (!/^[A-Za-z][\w-]*$/.test(name)) error = 'Names start with a letter and use letters, digits, _ and -';
                        else if (services()[name]) error = 'There is a service ' + name + ' already';
                        else if (!parsed) error = 'Enter a URL such as https://api.example.com/v1';
                        else {
                            change((all) => { all[name] = Object.assign(parsed, { endpoints: {} }); });
                            d.close();
                            R.go('services', name);
                            return;
                        }
                        d.update();
                    } }),
                ],
            }),
        });
    }

    function endpointDialog(service, name) {
        const existing = (services()[service].endpoints || {})[name];
        const ep = existing ? JSON.parse(JSON.stringify(existing)) : { path: '/', method: 'GET' };
        let epName = name || '';
        let error = '';
        const d = R.dialog({
            title: existing ? 'Endpoint ' + name : 'New endpoint', wide: true,
            render: () => ({
                body: [
                    h('div', { class: 'grid-2' },
                        h('div', { class: 'form-row' }, h('label', { for: 'ep-name', text: 'Name' }), h('input', { class: 'input', id: 'ep-name', value: epName, placeholder: 'getUser', oninput: (e) => { epName = e.target.value.trim(); } })),
                        h('div', { class: 'form-row' }, h('label', { for: 'ep-method', text: 'Method' }), R.select(METHODS, (ep.method || 'GET').toUpperCase(), (v) => { ep.method = v; }, { id: 'ep-method' }))),
                    h('div', { class: 'form-row' }, h('label', { for: 'ep-path', text: 'Path' }),
                        h('div', { class: 'with-addon' }, h('span', { class: 'addon mono', text: baseUrl(services()[service]) }),
                            h('input', { class: 'input mono', id: 'ep-path', value: ep.path, placeholder: '/users/{{id}}', oninput: (e) => { ep.path = e.target.value.trim(); } })),
                        h('div', { class: 'help', text: '{{name}} marks a path parameter — passed as params: { name } in ApiClient.call.' })),
                    h('div', { class: 'form-row' }, h('label', { for: 'ep-retry', text: 'Retries' }),
                        R.select([['', 'As the service'], ['on', 'Retry failed requests'], ['off', "Don't retry"]], ep.retry === true ? 'on' : ep.retry === false ? 'off' : '',
                            (v) => { if (v === 'on') ep.retry = true; else if (v === 'off') ep.retry = false; else delete ep.retry; }, { id: 'ep-retry' })),
                    h('div', { class: 'grid-2' },
                        h('div', { class: 'form-row' }, h('label', { text: 'Headers' }), R.kvEditor(ep.headers, (v) => { ep.headers = Object.keys(v).length ? v : undefined; d.update(); }, { id: 'ep-h', keyLabel: 'Header', newKey: 'X-Header', addLabel: 'Add header' })),
                        h('div', { class: 'form-row' }, h('label', { text: 'Query parameters' }), R.kvEditor(ep.queries, (v) => { ep.queries = Object.keys(v).length ? v : undefined; d.update(); }, { id: 'ep-q', keyLabel: 'Parameter', newKey: 'param', addLabel: 'Add parameter' }))),
                    error ? R.notice('bad', error) : null,
                ],
                actions: [
                    R.button('Cancel', { onClick: () => d.close() }),
                    R.button(existing ? 'Apply' : 'Add endpoint', { kind: 'primary', onClick: () => {
                        const all = services()[service].endpoints || {};
                        if (!/^[A-Za-z][\w-]*$/.test(epName)) error = 'Names start with a letter and use letters, digits, _ and -';
                        else if (epName !== name && all[epName]) error = 'There is an endpoint ' + epName + ' already';
                        else if (!ep.path || !ep.path.startsWith('/')) error = 'The path starts with /';
                        else {
                            change((list) => {
                                const s = list[service];
                                const next = {};
                                // Keep the order: a renamed endpoint stays where it was
                                for (const [k, v] of Object.entries(s.endpoints || {})) next[k === name ? epName : k] = k === name ? ep : v;
                                if (!name) next[epName] = ep;
                                s.endpoints = next;
                            });
                            d.close();
                            return;
                        }
                        d.update();
                    } }),
                ],
            }),
        });
    }

    function testDialog(service, endpoint) {
        const ep = services()[service].endpoints[endpoint];
        const values = S.ui['test-' + service + '.' + endpoint] || (S.ui['test-' + service + '.' + endpoint] = {});
        let result = null;
        const d = R.dialog({
            title: 'Test ' + service + ' · ' + endpoint, wide: true,
            render: () => ({
                body: [
                    h('div', { class: 'row', style: { marginBottom: '12px' } }, R.badge((ep.method || 'GET').toUpperCase(), 'brand'), h('code', { text: baseUrl(services()[service]) + ep.path })),
                    params(ep.path).length ? h('div', { class: 'grid-3' }, params(ep.path).map((p) => h('div', { class: 'form-row' }, h('label', { for: 'tp-' + p, text: p }),
                        h('input', { class: 'input', id: 'tp-' + p, value: values[p] || '', oninput: (e) => { values[p] = e.target.value; } })))) : null,
                    h('p', { class: 'muted small', text: 'Sent once from the server, with the settings as they are on screen — unsaved changes included. ' + ((ep.method || 'GET').toUpperCase() === 'GET' ? '' : 'Careful: this ' + (ep.method || '').toUpperCase() + ' request is real.') }),
                    result ? h('div', null,
                        h('div', { class: 'row', style: { marginBottom: '8px' } },
                            R.badge(result.status ? String(result.status) : 'No answer', result.ok ? 'ok' : 'bad'),
                            h('b', { text: result.status ? result.message.replace(/^\d+\s*/, '') || 'Answered' : result.message }),
                            result.durationMs !== undefined ? h('span', { class: 'muted', text: result.durationMs + ' ms' }) : null,
                            result.contentType ? h('span', { class: 'faint small', text: result.contentType }) : null),
                        result.url ? h('div', { class: 'small', style: { marginBottom: '8px' } }, h('code', { text: (result.method || '') + ' ' + result.url })) : null,
                        result.missing ? R.notice('warn', 'Not set: ' + result.missing.join(', '), 'These ${…} references have no value — enter them under Authorization.') : null,
                        result.preview ? h('pre', { class: 'code', text: result.preview }) : null) : null,
                ],
                actions: [
                    R.button('Close', { onClick: () => d.close() }),
                    R.button('Send request', { kind: 'primary', icon: 'send', busy: 'Sending…', onClick: async () => {
                        result = await R.api('POST', '/services/test', R.payload({ service, endpoint, params: values }));
                        d.update();
                    } }),
                ],
            }),
        });
    }

    // ── Detail ───────────────────────────────────────────────────────────
    function authFields(name, s) {
        const a = s.authorization || {};
        const set = (field, value) => change((all) => {
            const auth = all[name].authorization;
            if (value === undefined || value === '') delete auth[field]; else auth[field] = value;
        });
        const text = (field, label, placeholder, help) => h('div', { class: 'field' },
            h('div', null, h('label', { class: 'name', for: 'auth-' + field, text: label }), h('span', { class: 'key', text: field })),
            h('div', null, h('input', { class: 'input', id: 'auth-' + field, value: a[field] || '', placeholder: placeholder || '', onchange: (e) => set(field, e.target.value.trim()) }),
                help ? h('div', { class: 'help', text: help }) : null));
        const secret = (field, label, suffix) => h('div', { class: 'field' },
            h('div', null, h('label', { class: 'name', for: 'auth-' + field, text: label }), h('span', { class: 'key', text: field })),
            h('div', null, R.secretRef(a[field] || '', envName(name, suffix), (v) => set(field, v), { id: 'auth-' + field })));
        switch (a.type) {
            case 'basic': return [text('username', 'Username'), secret('password', 'Password', 'PASSWORD'), text('auth-header', 'Header', 'Authorization')];
            case 'bearer': return [secret('token', 'Token', 'TOKEN'), text('auth-header', 'Header', 'Authorization')];
            case 'api-key': return [secret('key', 'API key', 'API_KEY'), text('key-header', 'Header', 'X-API-Key', 'The header that carries the key.')];
            case 'oauth2': return [
                text('hostname', 'Token server', 'auth.example.com', 'Host of the token endpoint (client credentials grant).'),
                text('token_path', 'Token path', '/oauth/token'),
                text('client_id', 'Client id'),
                secret('client_secret', 'Client secret', 'CLIENT_SECRET'),
                text('scope', 'Scope', 'read write'),
                text('grant_type', 'Grant type', 'client_credentials'),
            ];
            default: return [h('p', { class: 'muted', style: { padding: '14px 0' }, text: 'Requests are sent without credentials.' })];
        }
    }

    function detail(name) {
        const s = services()[name];
        const problems = problemsOf(name);
        const endpoints = Object.entries(s.endpoints || {});
        const port = s.port === undefined ? '' : String(s.port);
        return [
            R.pageHead(name, baseUrl(s), [
                R.button('Delete service', { kind: 'danger', icon: 'trash', onClick: async () => {
                    if (!(await R.confirm({ title: 'Delete ' + name + '?', text: 'Code that calls ApiClient.call(\'' + name + '\', …) fails afterwards.', confirm: 'Delete', danger: true }))) return;
                    change((all) => { delete all[name]; });
                    R.go('services');
                } }),
            ], [h('a', { href: '#/services', onclick: (e) => { e.preventDefault(); R.go('services'); } }, 'Services'), R.icon('chevronRight'), h('span', { text: name })]),
            problems.length ? R.notice('bad', 'Problems', h('ul', null, problems.map((p) => h('li', { text: p.replace('services.' + name + '.', '') })))) : null,
            R.card({ title: 'Connection', icon: 'globe' },
                h('div', { class: 'field' },
                    h('div', null, h('span', { class: 'name', text: 'Name' }), h('span', { class: 'key', text: 'ApiClient.call(name, …)' })),
                    h('div', null, h('input', { class: 'input', id: 'svc-rename', value: name, onchange: (e) => {
                        const next = e.target.value.trim();
                        if (!/^[A-Za-z][\w-]*$/.test(next) || services()[next]) { R.toast('bad', 'Choose another name'); R.render(); return; }
                        change((all) => {
                            const entries = Object.entries(all).map(([k, v]) => [k === name ? next : k, v]);
                            for (const k of Object.keys(all)) delete all[k];
                            for (const [k, v] of entries) all[k] = v;
                        });
                        R.go('services', next);
                    } }))),
                h('div', { class: 'field' },
                    h('div', null, h('span', { class: 'name', text: 'Base URL' })),
                    h('div', null, h('div', { class: 'with-addon' },
                        h('span', { style: { flex: '0 0 112px', display: 'flex' } }, R.select([['https', 'https://'], ['http', 'http://']], s.secure === false ? 'http' : 'https',
                            (v) => change((all) => { if (v === 'http') all[name].secure = false; else delete all[name].secure; }), { label: 'Protocol' })),
                        h('input', { class: 'input mono', id: 'svc-host', value: s.hostname || '', placeholder: 'api.example.com', 'aria-label': 'Host name', onchange: (e) => change((all) => { all[name].hostname = e.target.value.trim(); }) }),
                        h('input', { class: 'input mono', id: 'svc-port', value: port, placeholder: 'port', style: { maxWidth: '90px' }, inputmode: 'numeric', 'aria-label': 'Port',
                            onchange: (e) => change((all) => { const v = e.target.value.trim(); if (v) all[name].port = Number(v); else delete all[name].port; }) }),
                        h('input', { class: 'input mono', id: 'svc-path', value: s.path || '', placeholder: '/v1', style: { maxWidth: '180px' }, 'aria-label': 'Base path',
                            onchange: (e) => change((all) => { const v = e.target.value.trim(); if (v) all[name].path = v; else delete all[name].path; }) })),
                    h('div', { class: 'help', text: 'Every endpoint path is appended to it.' }))),
                h('div', { class: 'field' },
                    h('div', null, h('span', { class: 'name', text: 'Retries' }), h('span', { class: 'key', text: 'retry' })),
                    h('div', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'svc-retry', checked: s.retry !== false,
                        onchange: (e) => change((all) => { if (e.target.checked) delete all[name].retry; else all[name].retry = false; }) }), 'Retry failed requests'),
                    h('div', { class: 'help', text: 'Network errors, 5xx and 429 are tried again — API_MAX_RETRIES times, with backoff — POST and PATCH too. Turn it off for a service whose calls must not run twice; an endpoint can decide for itself.' })))),
            R.card({ title: 'Authorization', icon: 'key', description: 'Credentials stay in the environment: config/app.json only references them as ${NAME}.',
                actions: [R.seg(AUTH, (s.authorization && s.authorization.type) || '', (v) => change((all) => {
                    if (!v) delete all[name].authorization;
                    else all[name].authorization = Object.assign({ type: v }, all[name].authorization && all[name].authorization['auth-header'] ? { 'auth-header': all[name].authorization['auth-header'] } : {});
                }), { label: 'Authorization type' })] },
            authFields(name, s)),
            R.card({ title: 'Defaults', icon: 'sliders', description: 'Sent with every endpoint of this service.' },
                h('div', { class: 'grid-2', style: { padding: '14px 0' } },
                    h('div', null, h('div', { class: 'name', style: { marginBottom: '8px' }, text: 'Headers' }),
                        R.kvEditor(s.headers, (v) => change((all) => { if (Object.keys(v).length) all[name].headers = v; else delete all[name].headers; }), { id: 'svc-h', keyLabel: 'Header', newKey: 'X-Header', addLabel: 'Add header' })),
                    h('div', null, h('div', { class: 'name', style: { marginBottom: '8px' }, text: 'Query parameters' }),
                        R.kvEditor(s.queries, (v) => change((all) => { if (Object.keys(v).length) all[name].queries = v; else delete all[name].queries; }), { id: 'svc-q', keyLabel: 'Parameter', newKey: 'param', addLabel: 'Add parameter' })))),
            R.card({ title: 'Endpoints', icon: 'send', description: 'Called by name: ApiClient.call(\'' + name + '\', \'' + (endpoints[0] ? endpoints[0][0] : 'endpoint') + '\', { params }).', body: 'flush',
                actions: [R.button('Add endpoint', { size: 'sm', icon: 'plus', onClick: () => endpointDialog(name, null) })] },
            endpoints.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Name', 'Method', 'Path', ''].map((t) => h('th', { text: t })))),
                h('tbody', null, endpoints.map(([ep, e]) => h('tr', null,
                    h('td', null, h('b', { text: ep })),
                    h('td', null, R.badge((e.method || 'GET').toUpperCase(), 'brand')),
                    h('td', null, h('code', { text: e.path })),
                    h('td', { class: 'shrink' }, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                        R.button('Test', { size: 'xs', icon: 'send', onClick: () => testDialog(name, ep) }),
                        R.button('Edit', { size: 'xs', kind: 'ghost', icon: 'edit', onClick: () => endpointDialog(name, ep) }),
                        R.button('', { size: 'xs', kind: 'ghost', icon: 'trash', aria: 'Delete ' + ep, onClick: () => change((all) => { delete all[name].endpoints[ep]; }) }))))))))
                : R.empty('send', 'No endpoints', 'Name the calls your code makes — then test them from here.', [R.button('Add endpoint', { kind: 'primary', icon: 'plus', onClick: () => endpointDialog(name, null) })])),
        ];
    }

    R.page({
        id: 'services', title: 'Services', group: 'Configuration', icon: 'plug',
        status: () => ((S.fileProblems.app || []).length ? 'bad' : ''),
        render: () => {
            const json = !!S.ui['json-app'];
            if (json || config() === null) {
                return [R.pageHead('Services', null, [R.button('Editor', { icon: 'plug', disabled: config() === null, onClick: () => { S.ui['json-app'] = false; R.render(); } })]),
                    R.fileNotice('app'),
                    R.card({ title: 'config/app.json', icon: 'file' }, h('div', { style: { padding: '14px 0' } }, R.jsonEditor('app', 'The whole file: services (ApiClient) and the other app settings it holds. ${NAME} references are filled from the environment.')))];
            }
            if (S.sub && services()[S.sub]) return detail(S.sub);
            const list = Object.entries(services());
            return [
                R.pageHead('Services', 'The external APIs your app calls: base URL, credentials and named endpoints — used in code as ApiClient.call(service, endpoint). Saved to config/app.json.', [
                    R.fileBadge('app'),
                    R.button('JSON', { icon: 'code', onClick: () => { S.ui['json-app'] = true; R.render(); } }),
                    R.button('Add service', { kind: 'primary', icon: 'plus', onClick: addDialog }),
                ]),
                R.fileNotice('app'),
                R.card({ title: 'Services', icon: 'plug', body: 'flush' },
                    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
                        h('thead', null, h('tr', null, ['Service', 'Base URL', 'Authorization', 'Endpoints', ''].map((t) => h('th', { text: t })))),
                        h('tbody', null, list.map(([name, s]) => h('tr', null,
                            h('td', null, h('a', { href: '#/services/' + encodeURIComponent(name), onclick: (e) => { e.preventDefault(); R.go('services', name); } }, h('b', { text: name })),
                                problemsOf(name).length ? h('div', { class: 'sub bad-text', text: problemsOf(name).length + ' problem(s)' }) : null),
                            h('td', null, h('code', { text: baseUrl(s) })),
                            h('td', null, s.authorization ? R.badge((AUTH.find((a) => a[0] === s.authorization.type) || [0, s.authorization.type])[1], 'outline', 'key') : h('span', { class: 'faint', text: 'None' })),
                            h('td', { class: 'num' }, String(Object.keys(s.endpoints || {}).length)),
                            h('td', { class: 'shrink' }, R.button('Open', { size: 'xs', icon: 'chevronRight', onClick: () => R.go('services', name) })))))))
                        : R.empty('plug', 'No services yet', 'Add the APIs your app talks to — payment, CRM, storage, …', [R.button('Add service', { kind: 'primary', icon: 'plus', onClick: addDialog })])),
                R.sectionCard(R.section('outgoing'), { title: 'Outgoing requests', description: 'Defaults for every ApiClient call.' }),
                R.section('services') ? R.sectionCard(R.section('services'), { title: 'Referenced variables', description: '${NAME} references in config/app.json and their values.' }) : null,
            ];
        },
    });
}

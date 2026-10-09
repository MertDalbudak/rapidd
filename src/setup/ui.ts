/**
 * The setup wizard page: one self-contained document (no external resources, so it works
 * offline and under a strict CSP). The script talks to /setup/api and renders everything
 * from the settings catalog it receives. Kept free of backticks and template placeholders
 * so it can live in this String.raw literal.
 */

const STYLE = String.raw`
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #5d6677; --line: #dfe3ea;
  --accent: #3157d5; --accent-text: #ffffff; --ok: #1e7f4f; --warn: #a1620a; --bad: #c22f2f;
  --ok-bg: #e8f5ee; --warn-bg: #fdf3e2; --bad-bg: #fbeaea; --code: #f0f2f6; --focus: #3157d555;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151b; --panel: #1a1e26; --text: #e6e9ef; --muted: #9aa3b2; --line: #2c323d;
    --accent: #7c9cff; --accent-text: #0d1220; --ok: #5fcf95; --warn: #e8b45c; --bad: #ff7d7d;
    --ok-bg: #173126; --warn-bg: #33270f; --bad-bg: #3a1a1c; --code: #232833; --focus: #7c9cff55;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
header h1 { font-size: 17px; margin: 0; font-weight: 650; }
header .file { margin-left: auto; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
.layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
nav { padding: 18px 10px; border-right: 1px solid var(--line); min-height: calc(100vh - 54px); }
nav button { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; border: 0; background: none; color: var(--text); padding: 7px 10px; border-radius: 7px; font: inherit; cursor: pointer; }
nav button:hover { background: var(--code); }
nav button.active { background: var(--accent); color: var(--accent-text); }
nav .dot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--muted); flex: none; }
nav .dot.ok { background: var(--ok); border-color: var(--ok); }
nav .dot.bad { background: var(--bad); border-color: var(--bad); }
nav button.active .dot { border-color: var(--accent-text); }
nav .group { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 14px 10px 4px; }
main { padding: 26px 34px 80px; min-width: 0; }
main h2 { margin: 0 0 4px; font-size: 22px; }
.lead { color: var(--muted); margin: 0 0 22px; }
.field { padding: 14px 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 6px 24px; }
.field:first-of-type { border-top: 0; }
.field label.name { font-weight: 600; }
.field .key { display: block; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
.field .help { color: var(--muted); font-size: 13.5px; margin-top: 6px; }
.req { color: var(--bad); margin-left: 3px; }
input[type=text], input[type=password], input[type=number], select, textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font: inherit;
}
textarea { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; min-height: 90px; resize: vertical; }
textarea.file { min-height: 360px; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 1px; }
input:disabled, select:disabled, textarea:disabled { opacity: .65; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row > input { flex: 1; min-width: 180px; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 99px; background: var(--code); color: var(--muted); }
.badge.env { background: var(--warn-bg); color: var(--warn); }
.badge.gen { background: var(--ok-bg); color: var(--ok); }
.msg { font-size: 13.5px; margin-top: 6px; }
.msg.error { color: var(--bad); } .msg.warning { color: var(--warn); }
button.btn { border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 7px 14px; border-radius: 7px; font: inherit; cursor: pointer; }
button.btn:hover { border-color: var(--accent); }
button.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.btn.small { padding: 4px 10px; font-size: 13px; }
button.btn:disabled { opacity: .55; cursor: default; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.seg button { border: 0; background: var(--panel); color: var(--text); padding: 6px 13px; font: inherit; cursor: pointer; border-right: 1px solid var(--line); }
.seg button:last-child { border-right: 0; }
.seg button.on { background: var(--accent); color: var(--accent-text); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 99px; padding: 4px 13px; font: inherit; cursor: pointer; }
.chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 14px 0; }
.panel h3 { margin: 0 0 8px; font-size: 15.5px; }
.result { border-radius: 9px; padding: 11px 14px; margin-top: 10px; font-size: 14px; }
.result.ok { background: var(--ok-bg); } .result.bad { background: var(--bad-bg); } .result.warn { background: var(--warn-bg); }
.result ul { margin: 6px 0 0; padding-left: 20px; }
.result .title { font-weight: 600; }
.ok-text { color: var(--ok); } .bad-text { color: var(--bad); } .warn-text { color: var(--warn); }
pre { background: var(--code); padding: 12px; border-radius: 8px; overflow: auto; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 380px; white-space: pre-wrap; word-break: break-word; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px; }
.stat .label { color: var(--muted); font-size: 13px; }
.stat .value { font-size: 16px; font-weight: 600; margin-top: 2px; word-break: break-word; }
.advanced { margin-top: 10px; }
.advanced > button { margin: 8px 0; }
.footer { display: flex; justify-content: space-between; margin-top: 28px; gap: 10px; }
.tabs { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
table.changes { width: 100%; border-collapse: collapse; font-size: 14px; }
table.changes td, table.changes th { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
table.changes th { color: var(--muted); font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.hidden { display: none !important; }
.notice { background: var(--warn-bg); color: var(--text); border-radius: 9px; padding: 10px 14px; margin: 0 0 16px; font-size: 14px; }
.center { max-width: 460px; margin: 12vh auto; padding: 0 16px; }
@media (max-width: 820px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  nav { min-height: 0; min-width: 0; border-right: 0; border-bottom: 1px solid var(--line); display: flex; overflow-x: auto; padding: 8px; }
  nav .group { display: none; }
  nav button { width: auto; white-space: nowrap; }
  main { padding: 20px 16px 60px; }
  .field { grid-template-columns: 1fr; }
  header .file { display: none; }
}
`;

const SCRIPT = String.raw`
(function () {
  'use strict';
  var S = { state: null, changes: {}, step: 'overview', validation: null, visible: {}, checks: {}, advanced: {}, reveal: {}, revealed: {},
            project: null, actions: null, actionOutput: null, admin: null, adminResult: null, files: {}, exportText: '', exportFormat: 'env', busy: false };
  var main = document.querySelector('main');
  var nav = document.querySelector('nav');

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function api(method, path, body) {
    return fetch('/setup/api' + path, {
      method: method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Rapidd-Setup': '1' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { location.href = '/setup'; throw new Error('Session expired'); }
        data.__status = r.status; return data;
      });
    });
  }

  // ── Values ──────────────────────────────────────────────────────────────
  function allSettings() { var out = []; S.state.sections.forEach(function (s) { s.settings.forEach(function (x) { out.push(x); }); }); return out; }
  function settingByKey(key) { return allSettings().filter(function (s) { return s.key === key; })[0]; }
  function info(key) { return S.state.values[key] || { value: '', hasValue: false, source: 'unset', locked: false }; }
  function isSecret(setting) { return setting.type === 'secret'; }
  function changed(key) { return Object.prototype.hasOwnProperty.call(S.changes, key); }
  function valueOf(key) {
    if (changed(key)) return S.changes[key];
    var s = settingByKey(key);
    if (s && isSecret(s)) return S.revealed[key] !== undefined ? S.revealed[key] : '';
    return info(key).value;
  }
  function setValue(key, value) {
    var original = info(key);
    var s = settingByKey(key);
    var secret = s && isSecret(s);
    if (!secret && value === original.value) delete S.changes[key];
    else if (secret && S.revealed[key] !== undefined && value === S.revealed[key]) delete S.changes[key];
    else if (secret && S.revealed[key] === undefined && value === '' && !S.state.suggested[key]) delete S.changes[key];
    else S.changes[key] = value;
    if (S.state.drivers.indexOf(key) !== -1) evaluateSoon(true); else evaluateSoon(false);
    renderNav();
  }

  var timer = null;
  function evaluateSoon(rerender) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      api('POST', '/evaluate', { changes: S.changes }).then(function (r) {
        S.validation = r.validation;
        r.sections.forEach(function (s) { S.visible[s.id] = s.visible; });
        renderNav();
        if (rerender) render(); else updateMessages();
      });
    }, rerender ? 120 : 350);
  }

  // ── Steps ───────────────────────────────────────────────────────────────
  function steps() {
    var list = [{ id: 'overview', title: 'Overview', group: 'Start' }];
    S.state.sections.forEach(function (s) {
      if (S.visible[s.id] !== false) list.push({ id: s.id, title: s.title, group: s.group, section: s });
    });
    list.push({ id: 'files', title: 'Config files', group: 'Project' });
    list.push({ id: 'project', title: 'Schema & code', group: 'Project' });
    list.push({ id: 'admin', title: 'First user', group: 'Project' });
    list.push({ id: 'review', title: S.state.mode === 'first-boot' ? 'Review & start' : 'Review & save', group: 'Finish' });
    return list;
  }
  function sectionState(section) {
    var v = S.validation; if (!v) return '';
    var keys = section.settings.map(function (s) { return s.key; }).filter(function (k) { return v.visible.indexOf(k) !== -1; });
    if (keys.some(function (k) { return v.errors[k]; })) return 'bad';
    if (S.checks[section.id] && S.checks[section.id].ok) return 'ok';
    return keys.some(function (k) { return valueOf(k) || info(k).hasValue; }) ? 'ok' : '';
  }
  function go(id) { S.step = id; history.replaceState(null, '', '#' + id); render(); window.scrollTo(0, 0); }

  function renderNav() {
    nav.textContent = '';
    var group = null;
    steps().forEach(function (step) {
      if (step.group !== group) { group = step.group; nav.appendChild(h('div', { class: 'group', text: group })); }
      var dot = step.section ? sectionState(step.section) : '';
      if (step.id === 'review') dot = Object.keys(S.validation ? S.validation.errors : {}).length ? 'bad' : '';
      nav.appendChild(h('button', { class: step.id === S.step ? 'active' : '', onclick: function () { go(step.id); } },
        h('span', { class: 'dot ' + dot }), step.title));
    });
  }

  // ── Fields ──────────────────────────────────────────────────────────────
  function fieldInput(setting) {
    var key = setting.key, i = info(key), locked = i.locked, value = valueOf(key);
    var input;
    if (setting.type === 'boolean') {
      var seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': setting.label });
      [['', 'Default'], ['true', 'Yes'], ['false', 'No']].forEach(function (o) {
        seg.appendChild(h('button', { type: 'button', class: value === o[0] ? 'on' : '', disabled: locked, role: 'radio', 'aria-checked': String(value === o[0]),
          onclick: function () { setValue(key, o[0]); render(); } }, o[1]));
      });
      return seg;
    }
    if (setting.type === 'enum') {
      input = h('select', { id: 'f-' + key, disabled: locked, onchange: function (e) { setValue(key, e.target.value); } },
        h('option', { value: '', text: 'Default' + (setting.default ? ' (' + setting.default + ')' : '') }),
        (setting.options || []).map(function (o) { return h('option', { value: o, text: o }); }));
      input.value = value;
      return input;
    }
    if (setting.type === 'multi') {
      var items = value ? value.split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean) : [];
      var chips = h('div', { class: 'chips' });
      (setting.options || []).forEach(function (o) {
        var on = items.indexOf(o) !== -1;
        chips.appendChild(h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), disabled: locked, 'aria-pressed': String(on),
          onclick: function () {
            var next = on ? items.filter(function (x) { return x !== o; }) : items.concat([o]);
            setValue(key, next.join(',')); render();
          } }, (on ? (items.indexOf(o) + 1) + '. ' : '') + o));
      });
      return h('div', null, chips, items.length > 1 ? h('div', { class: 'help', text: 'Order: ' + items.join(' → ') + ' (click to remove and re-add to reorder)' }) : null);
    }
    if (setting.type === 'json') {
      input = h('textarea', { id: 'f-' + key, disabled: locked, placeholder: setting.placeholder || '', spellcheck: 'false',
        oninput: function (e) { setValue(key, e.target.value); } });
      input.value = value;
      return input;
    }
    var secret = isSecret(setting);
    input = h('input', {
      id: 'f-' + key, type: secret && !S.reveal[key] ? 'password' : 'text', disabled: locked, spellcheck: 'false', autocomplete: secret ? 'new-password' : 'off',
      inputmode: setting.type === 'number' ? 'numeric' : null,
      placeholder: secret && i.hasValue && !changed(key) ? i.value + '  (set — type to replace)' : (setting.placeholder || (setting.default ? 'Default: ' + setting.default : '')),
      oninput: function (e) { setValue(key, e.target.value); }
    });
    input.value = value;
    if (!secret) return input;
    return h('div', { class: 'row' }, input,
      h('button', { type: 'button', class: 'btn small', disabled: locked, onclick: function () {
        S.reveal[key] = !S.reveal[key];
        // A saved value is fetched only when asked for
        if (S.reveal[key] && i.hasValue && !changed(key) && S.revealed[key] === undefined) {
          api('POST', '/reveal', { key: key }).then(function (r) { S.revealed[key] = r.value; render(); });
        } else render();
      } }, S.reveal[key] ? 'Hide' : 'Show'),
      setting.generate ? h('button', { type: 'button', class: 'btn small', disabled: locked, onclick: function () { setValue(key, randomSecret()); S.reveal[key] = true; render(); } }, 'Generate') : null);
  }

  function randomSecret() {
    var bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function field(setting) {
    var i = info(setting.key);
    var required = S.validation && S.validation.required.indexOf(setting.key) !== -1;
    var badges = h('div', { class: 'badges' });
    if (i.locked) badges.appendChild(h('span', { class: 'badge env', text: 'set by the environment — edit it there' }));
    else if (changed(setting.key)) badges.appendChild(h('span', { class: 'badge gen', text: S.state.suggested[setting.key] && S.changes[setting.key] === S.state.suggested[setting.key] ? 'generated — saved on finish' : 'changed' }));
    else if (i.source === 'file') badges.appendChild(h('span', { class: 'badge', text: 'from the env file' }));
    else if (setting.default) badges.appendChild(h('span', { class: 'badge', text: 'default: ' + setting.default }));
    return h('div', { class: 'field', id: 'field-' + setting.key },
      h('div', null,
        h('label', { class: 'name', for: 'f-' + setting.key }, setting.label, required ? h('span', { class: 'req', text: '*', title: 'required' }) : null),
        h('span', { class: 'key', text: setting.key })),
      h('div', null, fieldInput(setting),
        h('div', { class: 'help', text: setting.help }), badges,
        h('div', { class: 'msg', id: 'msg-' + setting.key })));
  }

  function updateMessages() {
    if (!S.validation) return;
    document.querySelectorAll('.field').forEach(function (el) {
      var key = el.id.slice(6), msg = document.getElementById('msg-' + key);
      if (!msg) return;
      var e = S.validation.errors[key], w = S.validation.warnings[key];
      msg.className = 'msg ' + (e ? 'error' : w ? 'warning' : '');
      msg.textContent = e || w || '';
    });
  }

  // ── Checks ──────────────────────────────────────────────────────────────
  function resultBox(r) {
    if (!r) return null;
    var cls = r.ok ? 'ok' : 'bad';
    var details = [];
    if (r.steps) r.steps.forEach(function (s) { details.push(h('li', null, h('span', { class: s.ok ? 'ok-text' : 'bad-text', text: s.ok ? '✓ ' : '✗ ' }), s.target + ' — ' + s.message)); });
    if (r.details) Object.keys(r.details).forEach(function (k) {
      var v = r.details[k];
      if (Array.isArray(v)) v = v.length + (v.length ? ': ' + v.slice(0, 30).join(', ') + (v.length > 30 ? ', …' : '') : '');
      else if (v && typeof v === 'object') v = JSON.stringify(v);
      details.push(h('li', null, k.replace(/_/g, ' ') + ': ' + v));
    });
    return h('div', { class: 'result ' + cls, role: 'status' }, h('div', { class: 'title', text: (r.ok ? '✓ ' : '✗ ') + r.message }), details.length ? h('ul', null, details) : null);
  }

  function checkPanel(section) {
    var name = section.check;
    var withLogin = name === 'ldap' || name === 'webdav';
    var user = h('input', { type: 'text', placeholder: 'test user (optional)', autocomplete: 'off', id: 'chk-user' });
    var pass = h('input', { type: 'password', placeholder: 'password', autocomplete: 'off', id: 'chk-pass' });
    var button = h('button', { type: 'button', class: 'btn', onclick: function () {
      button.disabled = true; button.textContent = 'Testing…';
      api('POST', '/check/' + name, { changes: S.changes, username: withLogin ? user.value : undefined, password: withLogin ? pass.value : undefined })
        .then(function (r) { S.checks[section.id] = r; render(); });
    } }, 'Test connection');
    return h('div', { class: 'panel' }, h('h3', { text: 'Connection test' }),
      withLogin ? h('div', { class: 'row' }, user, pass) : null,
      withLogin ? h('div', { class: 'help', text: 'With a test user, the sign-in itself is tried and the returned identity shown. Nothing is stored.' }) : null,
      h('div', { class: 'row' }, button),
      resultBox(S.checks[section.id]));
  }

  // ── Pages ───────────────────────────────────────────────────────────────
  function sectionPage(section) {
    var v = S.validation;
    var shown = section.settings.filter(function (s) { return !v || v.visible.indexOf(s.key) !== -1; });
    var basic = shown.filter(function (s) { return !s.advanced; });
    var adv = shown.filter(function (s) { return s.advanced; });
    var open = S.advanced[section.id] || adv.some(function (s) { return changed(s.key) || (v && v.errors[s.key]); });
    return [
      h('h2', { text: section.title }), h('p', { class: 'lead', text: section.description }),
      basic.map(field),
      adv.length ? h('div', { class: 'advanced' },
        h('button', { type: 'button', class: 'btn small', onclick: function () { S.advanced[section.id] = !open; render(); } },
          (open ? 'Hide' : 'Show') + ' advanced settings (' + adv.length + ')'),
        open ? adv.map(field) : null) : null,
      section.check ? checkPanel(section) : null
    ];
  }

  function stat(label, value, cls) { return h('div', { class: 'stat' }, h('div', { class: 'label', text: label }), h('div', { class: 'value ' + (cls || ''), text: value })); }

  function overviewPage() {
    var st = S.state, p = st.project, out = [h('h2', { text: 'Rapidd setup' })];
    if (st.mode === 'first-boot') {
      out.push(h('p', { class: 'lead', text: 'The API cannot start yet. Configure it here — it starts as soon as you finish.' }));
      out.push(h('div', { class: 'result bad' }, h('div', { class: 'title', text: 'Missing before the API can start' }),
        h('ul', null, st.reasons.map(function (r) { return h('li', null, h('span', { class: 'mono', text: r.key }), ' — ' + r.message); }))));
    } else {
      out.push(h('p', { class: 'lead', text: 'Every setting of this API, where it comes from, and what is configured.' }));
    }
    if (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) === -1) {
      out.push(h('div', { class: 'notice', text: 'This connection is not encrypted. Passwords and secrets you enter travel in clear text — prefer an SSH tunnel or run the wizard locally.' }));
    }
    if (st.container) out.push(h('div', { class: 'notice', text: 'Running in a container: files written here are lost on redeploy unless ' + st.envFile.path + ' is on a volume (set ENV_FILE). The review step exports the settings for compose or Kubernetes.' }));
    if (!st.envFile.writable) out.push(h('div', { class: 'notice', text: st.envFile.path + ' is not writable — set ENV_FILE to a writable path, or copy the export from the review step into your environment.' }));
    out.push(h('div', { class: 'grid' },
      stat('Env file', st.envFile.display + (st.envFile.exists ? '' : ' (new)')),
      stat('Prisma schema', p.schema.exists ? (p.schema.models.length + ' model(s) · ' + (p.schema.provider || '?')) : 'missing', p.schema.exists ? '' : 'bad-text'),
      stat('Prisma client', p.client.generated ? 'generated' : 'not generated', p.client.generated ? 'ok-text' : 'bad-text'),
      stat('Generated code', p.generated.models + ' models · ' + p.generated.routes + ' route files'),
      stat('ACL', p.acl.exists ? (p.acl.missing.length ? p.acl.missing.length + ' model(s) without an entry' : 'every model covered') : 'no src/config/acl.ts', p.acl.missing.length ? 'warn-text' : ''),
      stat('User table', p.userModel ? p.userModel.model : 'none detected')));
    out.push(h('div', { class: 'footer' }, h('span'), h('button', { class: 'btn primary', onclick: function () { go(steps()[1].id); } }, 'Start')));
    return out;
  }

  function filesPage() {
    var out = [h('h2', { text: 'Config files' }), h('p', { class: 'lead', text: 'JSON files next to the code. $' + '{NAME} references are filled from the environment — they appear under External services.' })];
    [['app', 'config/app.json', 'Outgoing API services (ApiClient), languages, endpoint auth.'], ['rateLimit', 'config/rate-limit.json', 'Per-path rate limits, e.g. "/auth/login": { "maxRequests": 10, "windowMs": 900000 }.']].forEach(function (f) {
      var id = f[0], file = S.files[id];
      var box = h('div', { class: 'panel' }, h('h3', { text: f[1] }), h('div', { class: 'help', text: f[2] }));
      if (!file) {
        box.appendChild(h('button', { class: 'btn', onclick: function () { api('GET', '/file/' + id).then(function (r) { S.files[id] = { content: r.content, info: r }; render(); }); } }, 'Open'));
      } else {
        var area = h('textarea', { class: 'file', spellcheck: 'false', oninput: function (e) { file.content = e.target.value; file.dirty = true; } });
        area.value = file.content || '';
        var status = file.error ? h('div', { class: 'msg error', text: file.error }) : file.saved ? h('div', { class: 'msg ok-text', text: 'Saved.' }) : null;
        box.appendChild(area);
        box.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: function () {
          api('PUT', '/file/' + id, { content: file.content }).then(function (r) {
            if (r.__status >= 400) { file.error = r.error; file.saved = false; } else { file.error = null; file.saved = true; file.dirty = false; refresh(); }
            render();
          });
        } }, 'Save file')));
        if (status) box.appendChild(status);
      }
      out.push(box);
    });
    return out;
  }

  var ACTION_LABELS = { generate: ['Generate Prisma client', 'prisma generate'], pull: ['Read schema from the database', 'prisma db pull — only while the schema has no models'],
    push: ['Create tables', 'prisma db push — only into a database without these tables'], migrate: ['Apply migrations', 'prisma migrate deploy'],
    build: ['Generate models, routes & ACL', 'rapidd build — existing files are kept'] };

  function projectPage() {
    var out = [h('h2', { text: 'Schema & code' }), h('p', { class: 'lead', text: 'The Prisma schema, the database tables and the code generated from them.' })];
    if (!S.project) {
      api('POST', '/project', { changes: S.changes }).then(function (r) { S.project = r.project; S.actions = r.actions; render(); });
      out.push(h('p', { text: 'Loading…' }));
      return out;
    }
    var p = S.project;
    out.push(h('div', { class: 'grid' },
      stat('Schema', p.schema.exists ? p.schema.models.length + ' model(s)' : 'missing'),
      stat('Database', p.schema.provider || '—'),
      stat('Client', p.client.generated ? 'generated' : 'not generated', p.client.generated ? 'ok-text' : 'bad-text'),
      stat('Migrations', p.migrations ? 'prisma/migrations' : 'none'),
      stat('Models / routes', p.generated.models + ' / ' + p.generated.routes)));
    if (p.schema.error) out.push(h('div', { class: 'result bad' }, h('div', { class: 'title', text: 'The schema has errors' }), h('pre', { text: p.schema.error })));
    if (p.acl.missing.length) out.push(h('div', { class: 'result warn' }, h('div', { class: 'title', text: 'Models without an ACL entry (src/config/acl.ts)' }), h('div', { text: p.acl.missing.join(', ') })));
    var list = h('div', { class: 'panel' }, h('h3', { text: 'Actions' }));
    Object.keys(ACTION_LABELS).forEach(function (name) {
      var blocker = S.actions[name];
      list.appendChild(h('div', { class: 'field' },
        h('div', null, h('label', { class: 'name', text: ACTION_LABELS[name][0] }), h('span', { class: 'key', text: ACTION_LABELS[name][1] })),
        h('div', null, h('button', { class: 'btn', disabled: !!blocker || S.busy, onclick: function () {
          S.busy = true; S.actionOutput = { name: name, running: true }; render();
          api('POST', '/action/' + name, { changes: S.changes }).then(function (r) { S.busy = false; S.actionOutput = { name: name, result: r }; S.project = null; refresh(); });
        } }, 'Run'), blocker ? h('div', { class: 'help', text: blocker }) : null)));
    });
    out.push(list);
    if (S.actionOutput) {
      var a = S.actionOutput;
      out.push(a.running ? h('div', { class: 'result warn', text: 'Running ' + ACTION_LABELS[a.name][1].split(' —')[0] + '…' })
        : h('div', null, resultBox({ ok: a.result.ok, message: a.result.message }), a.result.output ? h('pre', { text: a.result.output }) : null));
    }
    return out;
  }

  function adminPage() {
    var out = [h('h2', { text: 'First user' }), h('p', { class: 'lead', text: 'Create the first account of the user table — possible only while the table is empty.' })];
    if (!S.admin) {
      api('POST', '/admin/status', { changes: S.changes }).then(function (r) { S.admin = r; render(); });
      out.push(h('p', { text: 'Loading…' }));
      return out;
    }
    var a = S.admin;
    if (S.adminResult && S.adminResult.ok) { out.push(resultBox({ ok: true, message: S.adminResult.message })); return out; }
    if (!a.available) { out.push(h('div', { class: 'result warn', text: a.reason })); return out; }
    var form = h('form', { onsubmit: function (e) {
      e.preventDefault();
      var data = {};
      a.model.fields.forEach(function (f) { var el = document.getElementById('u-' + f.name); data[f.name] = el.type === 'checkbox' ? String(el.checked) : el.value; });
      data.password = document.getElementById('u-password').value;
      if (data.password !== document.getElementById('u-password2').value) { S.adminResult = { ok: false, message: 'The passwords differ', errors: { password: 'Does not match' } }; render(); return; }
      api('POST', '/admin', { changes: S.changes, user: data }).then(function (r) { S.adminResult = r; if (r.ok) S.admin = null; render(); });
    } });
    form.appendChild(h('div', { class: 'help', text: 'Table: ' + a.model.model + ' · sign-in with: ' + a.model.identifierFields.join(', ') }));
    var errors = (S.adminResult && S.adminResult.errors) || {};
    a.model.fields.forEach(function (f) {
      var input = f.enumValues ? h('select', { id: 'u-' + f.name }, h('option', { value: '', text: 'Default' + (f.default ? ' (' + f.default + ')' : '') }),
            f.enumValues.map(function (v) { return h('option', { value: v, text: v }); }))
        : f.type === 'Boolean' ? h('input', { type: 'checkbox', id: 'u-' + f.name, checked: f.default === 'true' })
        : h('input', { type: f.type === 'DateTime' ? 'datetime-local' : 'text', id: 'u-' + f.name, autocomplete: 'off', placeholder: f.default ? 'Default: ' + f.default : '' });
      form.appendChild(h('div', { class: 'field' }, h('div', null, h('label', { class: 'name', for: 'u-' + f.name }, f.name, f.required ? h('span', { class: 'req', text: '*' }) : null), h('span', { class: 'key', text: f.type })),
        h('div', null, input, errors[f.name] ? h('div', { class: 'msg error', text: errors[f.name] }) : null)));
    });
    ['password', 'password2'].forEach(function (id, i) {
      form.appendChild(h('div', { class: 'field' }, h('div', null, h('label', { class: 'name', for: 'u-' + id }, i ? 'Repeat password' : 'Password', h('span', { class: 'req', text: '*' }))),
        h('div', null, h('input', { type: 'password', id: 'u-' + id, autocomplete: 'new-password' }), errors[id === 'password' ? 'password' : 'x'] ? h('div', { class: 'msg error', text: errors.password }) : null)));
    });
    form.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create account')));
    if (S.adminResult && !S.adminResult.ok) form.appendChild(resultBox(S.adminResult));
    out.push(form);
    return out;
  }

  function reviewPage() {
    var v = S.validation, keys = Object.keys(S.changes);
    var out = [h('h2', { text: S.state.mode === 'first-boot' ? 'Review & start' : 'Review & save' }),
      h('p', { class: 'lead', text: 'Changes are written to ' + S.state.envFile.display + ' (the previous version is kept as ' + S.state.envFile.display + '.bak).' })];
    var errorKeys = Object.keys(v.errors);
    if (errorKeys.length) {
      out.push(h('div', { class: 'result bad' }, h('div', { class: 'title', text: 'Fix these first' }),
        h('ul', null, errorKeys.map(function (k) {
          var sec = S.state.sections.filter(function (s) { return s.settings.some(function (x) { return x.key === k; }); })[0];
          return h('li', null, h('a', { href: '#', onclick: function (e) { e.preventDefault(); go(sec.id); } }, k), ' — ' + v.errors[k]);
        }))));
    }
    var warnKeys = Object.keys(v.warnings);
    if (warnKeys.length) out.push(h('div', { class: 'result warn' }, h('div', { class: 'title', text: 'Worth a look' }), h('ul', null, warnKeys.map(function (k) { return h('li', null, k + ' — ' + v.warnings[k]); }))));
    var table = h('table', { class: 'changes' }, h('tr', null, h('th', { text: 'Setting' }), h('th', { text: 'Before' }), h('th', { text: 'After' })));
    keys.forEach(function (k) {
      var s = settingByKey(k) || { key: k, type: 'string' };
      var before = info(k).hasValue ? info(k).value : '—';
      var after = S.changes[k] === '' ? '(removed)' : isSecret(s) ? '•••••• (new)' : S.changes[k];
      table.appendChild(h('tr', null, h('td', { class: 'mono', text: k }), h('td', { text: before }), h('td', { text: after })));
    });
    out.push(h('div', { class: 'panel' }, h('h3', { text: keys.length ? keys.length + ' change(s)' : 'No changes' }), keys.length ? table : null));

    var tabs = h('div', { class: 'tabs' });
    [['env', '.env'], ['compose', 'docker compose'], ['kubernetes', 'Kubernetes Secret'], ['shell', 'shell']].forEach(function (t) {
      tabs.appendChild(h('button', { class: 'btn small' + (S.exportFormat === t[0] && S.exportText ? ' primary' : ''), onclick: function () {
        S.exportFormat = t[0];
        api('POST', '/export', { changes: S.changes, format: t[0] }).then(function (r) { S.exportText = r.text; render(); });
      } }, t[1]));
    });
    out.push(h('div', { class: 'panel' }, h('h3', { text: 'Export' }),
      h('div', { class: 'help', text: 'The complete configuration including these changes — for compose files, Kubernetes or a secret store. Contains secrets.' }), tabs,
      S.exportText ? h('pre', { text: S.exportText }) : null,
      S.exportText ? h('button', { class: 'btn small', onclick: function (e) { navigator.clipboard.writeText(S.exportText); e.target.textContent = 'Copied'; } }, 'Copy') : null));

    var status = h('div');
    var saveBtn = h('button', { class: 'btn', disabled: !keys.length || errorKeys.length > 0, onclick: function () { save(false, status); } }, 'Save');
    var finishBtn = h('button', { class: 'btn primary', disabled: errorKeys.length > 0, onclick: function () { save(true, status); } },
      S.state.mode === 'first-boot' ? 'Save and start the API' : 'Save and close');
    out.push(h('div', { class: 'footer' }, saveBtn, finishBtn), status);
    return out;
  }

  function save(finish, status) {
    status.textContent = '';
    api('POST', finish ? '/finish' : '/save', { changes: S.changes }).then(function (r) {
      if (r.__status >= 400) {
        if (r.validation) S.validation = r.validation;
        status.appendChild(resultBox({ ok: false, message: r.error || 'Failed', steps: (r.reasons || []).map(function (x) { return { target: x.key, ok: false, message: x.message }; }) }));
        renderNav();
        return;
      }
      S.changes = {};
      if (!finish) { status.appendChild(resultBox({ ok: true, message: 'Saved to ' + r.saved.file })); refresh(); return; }
      done(r);
    });
  }

  function done(r) {
    nav.textContent = '';
    main.textContent = '';
    if (r.mode !== 'first-boot') {
      main.appendChild(h('div', null, h('h2', { text: 'Saved' }), h('p', { class: 'lead', text: 'The wizard has closed. Restart the API to apply the new settings.' })));
      return;
    }
    var line = h('p', { class: 'lead', text: 'Starting the API…' });
    main.appendChild(h('div', null, h('h2', { text: 'Setup complete' }), line));
    var samePort = String(r.port) === (location.port || (location.protocol === 'https:' ? '443' : '80'));
    if (!samePort) { line.textContent = 'The API starts on port ' + r.port + '.'; return; }
    var tries = 0;
    (function poll() {
      fetch('/health', { cache: 'no-store' }).then(function (x) { return x.json(); }).then(function (j) {
        if (j.status && j.status !== 'setup') { line.textContent = 'The API is running.'; main.appendChild(h('p', null, h('a', { href: '/health/ready', text: 'Readiness check' }))); }
        else if (++tries < 60) setTimeout(poll, 1000);
      }).catch(function () { if (++tries < 60) setTimeout(poll, 1000); else line.textContent = 'The API did not answer — check the server console.'; });
    })();
  }

  function refresh() {
    return api('GET', '/state').then(function (st) {
      S.state = st;
      Object.keys(st.suggested || {}).forEach(function (k) { if (!changed(k)) S.changes[k] = st.suggested[k]; });
      st.sections.forEach(function (s) { S.visible[s.id] = s.visible; });
      return api('POST', '/evaluate', { changes: S.changes });
    }).then(function (r) {
      S.validation = r.validation;
      r.sections.forEach(function (s) { S.visible[s.id] = s.visible; });
      S.project = null; S.admin = null;
      render();
    });
  }

  function render() {
    renderNav();
    main.textContent = '';
    var list = steps(), index = list.map(function (s) { return s.id; }).indexOf(S.step);
    if (index === -1) { S.step = 'overview'; index = 0; }
    var step = list[index];
    var content = step.id === 'overview' ? overviewPage() : step.id === 'files' ? filesPage() : step.id === 'project' ? projectPage()
      : step.id === 'admin' ? adminPage() : step.id === 'review' ? reviewPage() : sectionPage(step.section);
    content.forEach(function (c) { if (c) main.appendChild(Array.isArray(c) ? h('div', null, c) : c); });
    if (step.id !== 'overview' && step.id !== 'review') {
      main.appendChild(h('div', { class: 'footer' },
        h('button', { class: 'btn', onclick: function () { go(list[index - 1].id); } }, '← Back'),
        h('button', { class: 'btn primary', onclick: function () { go(list[index + 1].id); } }, 'Next →')));
    }
    updateMessages();
  }

  // The step lives in the URL hash: links to a step work, and a reload stays on it
  if (location.hash.length > 1) S.step = decodeURIComponent(location.hash.slice(1));
  refresh().then(function () {
    var file = document.querySelector('header .file');
    file.textContent = S.state.envFile.display; file.title = S.state.envFile.path;
  });
})();
`;

function page(nonce: string, title: string, body: string, script = ''): string {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + `<meta name="robots" content="noindex"><title>${title}</title><style nonce="${nonce}">${STYLE}</style></head><body>${body}`
        + (script ? `<script nonce="${nonce}">${script}</script>` : '') + '</body></html>';
}

export function wizardPage(nonce: string): string {
    return page(nonce, 'Rapidd setup',
        '<header><h1>Rapidd setup</h1><span class="file"></span></header><div class="layout"><nav aria-label="Steps"></nav><main id="main"><p>Loading…</p></main></div>',
        SCRIPT);
}

export function passwordPage(nonce: string, error?: string): string {
    const escaped = (error ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    return page(nonce, 'Rapidd setup',
        '<div class="center"><div class="panel"><h2>Rapidd setup</h2>'
        + '<p class="lead">Enter the setup password printed in the server console (or open the link shown there).</p>'
        + (escaped ? `<div class="result bad">${escaped}</div>` : '')
        + '<form method="get" action="/setup"><div class="row"><input type="password" name="password" autocomplete="off" autofocus aria-label="Setup password" placeholder="Setup password">'
        + '<button class="btn primary" type="submit">Continue</button></div></form></div></div>');
}

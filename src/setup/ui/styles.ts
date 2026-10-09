/**
 * The wizard's stylesheet. Colours follow the logo (#3390cf → #273449); light and dark themes
 * (system preference, or the theme switch in the top bar). No external resources — the page
 * runs under a strict CSP, offline.
 */
export const STYLES = `
:root {
  --bg: #f3f5f8; --surface: #ffffff; --surface-2: #f8fafc; --surface-3: #eef2f6;
  --border: #e2e8f0; --border-strong: #cbd5e1;
  --text: #0f172a; --text-2: #475569; --text-3: #8492a6;
  --brand: #307db3; --brand-hover: #2d638c; --brand-soft: #e7f1f9; --brand-ink: #1f5682; --brand-ring: rgba(48, 125, 179, .28);
  --ok: #15803d; --ok-soft: #ecfdf3; --ok-line: #bbf7d0;
  --warn: #b45309; --warn-soft: #fffbeb; --warn-line: #fde68a;
  --bad: #b91c1c; --bad-soft: #fef2f2; --bad-line: #fecaca;
  --top: #1c2838; --top-2: #273449; --top-text: #e8eef6; --top-muted: #9fb0c6;
  --code-bg: #0f1726; --code-text: #dbe5f1;
  --shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 1px 3px rgba(15, 23, 42, .06);
  --shadow-lg: 0 18px 48px rgba(15, 23, 42, .22), 0 4px 12px rgba(15, 23, 42, .1);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0b111b; --surface: #111a28; --surface-2: #0f1723; --surface-3: #1a2536;
    --border: #1f2b3d; --border-strong: #2c3b52;
    --text: #e3e9f2; --text-2: #9fb0c6; --text-3: #6b7d95;
    --brand: #4f9fd8; --brand-hover: #6db2e3; --brand-soft: #14283d; --brand-ink: #9cccf0; --brand-ring: rgba(79, 159, 216, .35);
    --ok: #4ade80; --ok-soft: #0f2a1c; --ok-line: #1d5a36;
    --warn: #fbbf24; --warn-soft: #2a2110; --warn-line: #5c4512;
    --bad: #f87171; --bad-soft: #2d1416; --bad-line: #6b2427;
    --top: #0a1019; --top-2: #142034;
    --code-bg: #070c14;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4); --shadow-lg: 0 18px 48px rgba(0, 0, 0, .6);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0b111b; --surface: #111a28; --surface-2: #0f1723; --surface-3: #1a2536;
  --border: #1f2b3d; --border-strong: #2c3b52;
  --text: #e3e9f2; --text-2: #9fb0c6; --text-3: #6b7d95;
  --brand: #4f9fd8; --brand-hover: #6db2e3; --brand-soft: #14283d; --brand-ink: #9cccf0; --brand-ring: rgba(79, 159, 216, .35);
  --ok: #4ade80; --ok-soft: #0f2a1c; --ok-line: #1d5a36;
  --warn: #fbbf24; --warn-soft: #2a2110; --warn-line: #5c4512;
  --bad: #f87171; --bad-soft: #2d1416; --bad-line: #6b2427;
  --top: #0a1019; --top-2: #142034;
  --code-bg: #070c14;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4); --shadow-lg: 0 18px 48px rgba(0, 0, 0, .6);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
[hidden] { display: none !important; }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
button, input, select, textarea { font: inherit; color: inherit; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
svg.icon { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
svg.icon.lg { width: 20px; height: 20px; }
:focus-visible { outline: 3px solid var(--brand-ring); outline-offset: 1px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ── Top bar ─────────────────────────────────────────────────────────── */
.topbar { position: sticky; top: 0; z-index: 30; height: 56px; display: flex; align-items: center; gap: 14px; padding: 0 18px;
  background: linear-gradient(90deg, var(--top), var(--top-2)); color: var(--top-text); box-shadow: 0 1px 0 rgba(0,0,0,.25); }
.brand { display: flex; align-items: center; gap: 10px; color: inherit; font-weight: 650; font-size: 16px; letter-spacing: .1px; }
.brand img { width: 30px; height: 30px; border-radius: 8px; display: block; }
.brand .product { color: var(--top-muted); font-weight: 500; padding-left: 10px; border-left: 1px solid rgba(255,255,255,.18); }
.topbar .project { color: var(--top-muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar .project b { color: var(--top-text); font-weight: 600; }
.topbar .spacer { flex: 1; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 99px; font-size: 12.5px; font-weight: 550; white-space: nowrap; }
.topbar .pill { background: rgba(255,255,255,.08); color: var(--top-text); border: 1px solid rgba(255,255,255,.12); }
.pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.topbar .pill.setup .dot { background: #fbbf24; box-shadow: 0 0 0 3px rgba(251,191,36,.18); }
.topbar .pill.ready .dot { background: #4ade80; box-shadow: 0 0 0 3px rgba(74,222,128,.18); }
.topbar .envfile { font-family: var(--mono); font-size: 12px; color: var(--top-muted); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; border: 0; background: transparent; color: inherit; cursor: pointer; }
.topbar .icon-btn:hover { background: rgba(255,255,255,.1); }
.topbar .menu-btn { display: none; }

/* ── Shell ───────────────────────────────────────────────────────────── */
.shell { display: grid; grid-template-columns: 256px minmax(0, 1fr); min-height: calc(100vh - 56px); }
.sidebar { position: sticky; top: 56px; align-self: start; height: calc(100vh - 56px); overflow-y: auto; padding: 14px 10px 24px;
  background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
.nav-group { font-size: 11px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); padding: 14px 10px 6px; }
.nav-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: none;
  color: var(--text-2); font-weight: 520; text-align: left; cursor: pointer; position: relative; }
.nav-item:hover { background: var(--surface-3); color: var(--text); }
.nav-item.active { background: var(--brand-soft); color: var(--brand-ink); }
.nav-item.active::before { content: ""; position: absolute; left: -10px; top: 6px; bottom: 6px; width: 3px; border-radius: 0 3px 3px 0; background: var(--brand); }
.nav-item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-item .state { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.nav-item .state svg { width: 12px; height: 12px; stroke-width: 3; }
.nav-item .state.ok { background: var(--ok-soft); color: var(--ok); }
.nav-item .state.bad { background: var(--bad-soft); color: var(--bad); }
.nav-item .state.warn { background: var(--warn-soft); color: var(--warn); }
.nav-item .count { font-size: 11.5px; font-weight: 650; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 99px; background: var(--brand); color: #fff; display: inline-flex; align-items: center; justify-content: center; }
.sidebar .grow { flex: 1; min-height: 16px; }
.sidebar .finish { margin: 8px 4px 0; }
.sidebar .meta { font-size: 12px; color: var(--text-3); padding: 10px; }

main { min-width: 0; padding: 26px 36px 140px; }
.page { max-width: 1120px; margin: 0 auto; }
.page-head { display: flex; align-items: flex-start; gap: 18px; margin-bottom: 20px; }
.page-head .titles { flex: 1; min-width: 0; }
.page-head h1 { margin: 0; font-size: 22px; line-height: 1.3; font-weight: 680; letter-spacing: -.2px; }
.page-head p { margin: 5px 0 0; color: var(--text-2); max-width: 760px; }
.page-head .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.crumbs { font-size: 12.5px; color: var(--text-3); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
.crumbs a { color: var(--text-2); }

/* ── Cards ───────────────────────────────────────────────────────────── */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); margin-bottom: 18px; }
.card-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.card-head .titles { flex: 1; min-width: 0; }
.card-head h2 { margin: 0; font-size: 15px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.card-head p { margin: 3px 0 0; color: var(--text-2); font-size: 13px; }
.card-head .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card-body { padding: 4px 20px; }
.card-body.pad { padding: 16px 20px; }
.card-body.flush { padding: 0; }
.card-foot { padding: 12px 20px; border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 12px 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card.compact .card-head { padding: 12px 16px; }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }

/* ── Fields ──────────────────────────────────────────────────────────── */
.field { display: grid; grid-template-columns: minmax(180px, 290px) minmax(0, 1fr); gap: 6px 28px; padding: 16px 0; border-top: 1px solid var(--border); }
.field:first-child { border-top: 0; }
.field .name { font-weight: 600; display: block; }
.field .key { display: inline-block; margin-top: 3px; font-family: var(--mono); font-size: 11.5px; color: var(--text-3); overflow-wrap: anywhere; }
.field .help { color: var(--text-2); font-size: 13px; margin-top: 6px; }
.field .meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.field.changed .name::after { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--brand); margin-left: 7px; vertical-align: 2px; }
.req { color: var(--bad); margin-left: 3px; }
.msg { font-size: 13px; margin-top: 6px; display: flex; gap: 6px; align-items: flex-start; }
.msg:empty { display: none; }
.msg.error { color: var(--bad); }
.msg.warning { color: var(--warn); }
.input, select.input, textarea.input {
  width: 100%; height: 36px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text);
  transition: border-color .12s, box-shadow .12s; }
textarea.input { height: auto; min-height: 96px; padding: 9px 11px; font-family: var(--mono); font-size: 12.5px; line-height: 1.5; resize: vertical; }
textarea.input.tall { min-height: 420px; }
.input:hover { border-color: var(--text-3); }
.input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
.input:disabled { background: var(--surface-2); color: var(--text-3); cursor: not-allowed; }
.input.invalid { border-color: var(--bad); }
.input.mono { font-family: var(--mono); font-size: 12.5px; }
.input.sm { height: 30px; padding: 0 8px; font-size: 13px; }
select.input { padding-right: 28px; }
.with-addon { display: flex; align-items: stretch; }
.with-addon .input { border-radius: 0; margin-left: -1px; }
.with-addon > :first-child, .with-addon > span:first-child > .input { border-radius: 8px 0 0 8px; margin-left: 0; }
.with-addon > :last-child { border-radius: 0 8px 8px 0; }
.addon { display: inline-flex; align-items: center; padding: 0 10px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text-2); font-size: 13px; white-space: nowrap; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row > .input { flex: 1; min-width: 160px; }
.stack { display: flex; flex-direction: column; gap: 10px; }
.check { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.check input { width: 16px; height: 16px; accent-color: var(--brand); margin: 0; }

/* ── Buttons ─────────────────────────────────────────────────────────── */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--text); font-weight: 560; cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s, box-shadow .12s; }
.btn:hover { background: var(--surface-3); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, .15); }
.btn.primary:hover:not(:disabled) { background: var(--brand-hover); border-color: var(--brand-hover); }
.btn.danger { color: var(--bad); }
.btn.danger.solid { background: var(--bad); border-color: var(--bad); color: #fff; }
.btn.ghost { border-color: transparent; background: transparent; color: var(--text-2); }
.btn.ghost:hover { background: var(--surface-3); color: var(--text); }
.btn.sm { height: 30px; padding: 0 10px; font-size: 13px; border-radius: 7px; }
.btn.xs { height: 26px; padding: 0 8px; font-size: 12.5px; border-radius: 6px; gap: 5px; }
.btn.block { width: 100%; }
.btn .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 9px; background: var(--surface-3); border: 1px solid var(--border); flex-wrap: wrap; }
.seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; color: var(--text-2); font-weight: 560; cursor: pointer; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.seg button:disabled { cursor: not-allowed; opacity: .6; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 99px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); font-weight: 540; cursor: pointer; }
.chip:hover { border-color: var(--brand); color: var(--text); }
.chip.on { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-ink); }
.chip .ord { font-size: 11px; font-weight: 700; width: 18px; height: 18px; border-radius: 50%; background: var(--brand); color: #fff; display: inline-flex; align-items: center; justify-content: center; }

/* ── Badges, notices, results ────────────────────────────────────────── */
.badge { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 560; background: var(--surface-3); color: var(--text-2); white-space: nowrap; }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.bad { background: var(--bad-soft); color: var(--bad); }
.badge.brand { background: var(--brand-soft); color: var(--brand-ink); }
.badge.outline { background: transparent; border: 1px solid var(--border-strong); }
.badge svg { width: 12px; height: 12px; stroke-width: 2.5; }
.notice { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); margin-bottom: 14px; }
.notice > svg { margin-top: 2px; }
.notice .body { flex: 1; min-width: 0; }
.notice .title { font-weight: 620; }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
.notice li { margin: 3px 0; }
.notice.info { background: var(--brand-soft); border-color: transparent; color: var(--text); }
.notice.info > svg { color: var(--brand); }
.notice.ok { background: var(--ok-soft); border-color: var(--ok-line); }
.notice.ok > svg { color: var(--ok); }
.notice.warn { background: var(--warn-soft); border-color: var(--warn-line); }
.notice.warn > svg { color: var(--warn); }
.notice.bad { background: var(--bad-soft); border-color: var(--bad-line); }
.notice.bad > svg { color: var(--bad); }
.notice .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.result { margin-top: 12px; }
.steps { list-style: none; margin: 8px 0 0; padding: 0; }
.steps li { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; }
.steps li svg { margin-top: 2px; }
.ok-text { color: var(--ok); } .bad-text { color: var(--bad); } .warn-text { color: var(--warn); } .muted { color: var(--text-2); } .faint { color: var(--text-3); }
.small { font-size: 12.5px; }

/* ── Tables ──────────────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.table th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-3); font-weight: 650; padding: 10px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border); white-space: nowrap; }
.table td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.table tr:last-child td { border-bottom: 0; }
.table tbody tr:hover td { background: var(--surface-2); }
.table td.shrink, .table th.shrink { width: 1%; white-space: nowrap; }
.table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.table .sub { color: var(--text-3); font-size: 12px; }
.table .sub a { color: inherit; } .table .sub a:hover { color: var(--brand); }
.table tr.selected td { background: var(--brand-soft); }
.table td .input { min-width: 90px; }

/* ── Stats & checklist ───────────────────────────────────────────────── */
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); min-width: 0; }
.stat .label { color: var(--text-2); font-size: 12.5px; display: flex; align-items: center; gap: 7px; }
.stat .value { font-size: 18px; font-weight: 650; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat .hint { color: var(--text-3); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.checklist { list-style: none; margin: 0; padding: 0; }
.checklist li { display: flex; align-items: center; gap: 14px; padding: 13px 20px; border-top: 1px solid var(--border); }
.checklist li:first-child { border-top: 0; }
.checklist .mark { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; border: 2px solid var(--border-strong); color: var(--text-3); font-weight: 700; font-size: 12.5px; }
.checklist .mark.ok { background: var(--ok); border-color: var(--ok); color: #fff; }
.checklist .mark.warn { background: var(--warn-soft); border-color: var(--warn); color: var(--warn); }
.checklist .mark.bad { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); }
.checklist .mark svg { width: 15px; height: 15px; stroke-width: 3; }
.checklist .text { flex: 1; min-width: 0; }
.checklist .text b { font-weight: 620; }
.checklist .text div { color: var(--text-2); font-size: 13px; }
.hero { display: flex; gap: 20px; align-items: center; padding: 22px 24px; border-radius: 14px; margin-bottom: 18px; color: #fff;
  background: radial-gradient(1200px 300px at 0% 0%, #3390cf 0%, #2d638c 45%, #273449 100%); box-shadow: var(--shadow); }
.hero img { width: 64px; height: 64px; border-radius: 16px; box-shadow: 0 6px 18px rgba(0,0,0,.25); }
.hero h1 { margin: 0; font-size: 22px; font-weight: 680; }
.hero p { margin: 4px 0 0; color: rgba(255,255,255,.82); max-width: 720px; }
.hero .actions { margin-left: auto; display: flex; gap: 8px; }
.hero .btn { border-color: rgba(255,255,255,.35); background: rgba(255,255,255,.12); color: #fff; }
.hero .btn:hover { background: rgba(255,255,255,.2); }
.hero .btn.primary { background: #fff; color: #1f4f78; border-color: #fff; }

/* ── Code, console, diff ─────────────────────────────────────────────── */
pre.code, pre.console { margin: 0; padding: 14px 16px; border-radius: 10px; background: var(--code-bg); color: var(--code-text); font: 12.5px/1.55 var(--mono); overflow: auto; max-height: 420px; white-space: pre-wrap; word-break: break-word; }
pre.code.light { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
.console-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.diff { font: 12.5px/1.6 var(--mono); border: 1px solid var(--border); border-radius: 10px; overflow: auto; max-height: 460px; background: var(--surface); }
.diff div { padding: 0 12px 0 10px; white-space: pre-wrap; word-break: break-all; border-left: 3px solid transparent; }
.diff .add { background: var(--ok-soft); border-left-color: var(--ok); }
.diff .del { background: var(--bad-soft); border-left-color: var(--bad); }
.diff .gap { color: var(--text-3); background: var(--surface-2); }
.diff .sign { display: inline-block; width: 16px; color: var(--text-3); user-select: none; }

/* ── Split view (list + detail) ──────────────────────────────────────── */
.split { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; align-items: start; }
.list-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; position: sticky; top: 74px; }
.list-panel .tools { padding: 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.list-panel .items { max-height: calc(100vh - 230px); overflow-y: auto; padding: 6px; }
.list-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: none; text-align: left; cursor: pointer; color: var(--text); }
.list-item:hover { background: var(--surface-3); }
.list-item.active { background: var(--brand-soft); color: var(--brand-ink); }
.list-item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 540; }

/* ── Search & tabs ───────────────────────────────────────────────────── */
.search { position: relative; }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-3); }
.search .input { padding-left: 32px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 18px; overflow-x: auto; }
.tabs button { height: 38px; padding: 0 12px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-2); font-weight: 560; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.tabs button:hover { color: var(--text); }
.tabs button.on { color: var(--brand-ink); border-bottom-color: var(--brand); }
.tabs .n { font-size: 11px; background: var(--surface-3); color: var(--text-2); border-radius: 99px; padding: 1px 7px; }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.toolbar .search { flex: 1; min-width: 220px; max-width: 420px; }

/* ── Save bar, toasts, dialogs ───────────────────────────────────────── */
.savebar { position: fixed; z-index: 40; left: calc(256px + 24px); right: 24px; bottom: 18px; display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 18px;
  border-radius: 12px; background: var(--top); color: var(--top-text); box-shadow: var(--shadow-lg); max-width: 1120px; margin: 0 auto; }
.savebar .text { flex: 1; min-width: 0; }
.savebar .text b { font-weight: 650; }
.savebar .text span { color: var(--top-muted); margin-left: 8px; font-size: 13px; }
.savebar .btn.ghost { color: var(--top-text); }
.savebar .btn.ghost:hover { background: rgba(255,255,255,.1); }
.toasts { position: fixed; z-index: 60; top: 68px; right: 18px; display: flex; flex-direction: column; gap: 8px; width: min(380px, calc(100vw - 36px)); }
.toast { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-lg); animation: rise .18s ease-out; }
.toast.ok > svg { color: var(--ok); } .toast.bad > svg { color: var(--bad); } .toast.warn > svg { color: var(--warn); } .toast.info > svg { color: var(--brand); }
.toast .body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
@keyframes rise { from { transform: translateY(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
.backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(9, 14, 24, .55); display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px; overflow-y: auto; animation: fade .12s ease-out; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.dialog { width: 100%; max-width: 620px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-lg); border: 1px solid var(--border); animation: rise .16s ease-out; }
.dialog.wide { max-width: 880px; }
.dialog-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.dialog-head h2 { margin: 0; font-size: 16px; font-weight: 650; flex: 1; }
.dialog-body { padding: 18px 20px; max-height: 68vh; overflow-y: auto; }
.dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 14px 14px; }
.dialog-foot .left { margin-right: auto; }
.form-row { margin-bottom: 14px; }
.form-row > label:not(.check) { display: block; font-weight: 600; margin-bottom: 6px; }
.form-row > label.check { display: flex; }
.form-row .help { color: var(--text-2); font-size: 12.5px; margin-top: 5px; }
.empty { text-align: center; padding: 36px 20px; color: var(--text-2); }
.empty svg { width: 30px; height: 30px; color: var(--text-3); margin-bottom: 8px; }
.empty .title { font-weight: 620; color: var(--text); margin-bottom: 4px; }
.empty .actions { margin-top: 14px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.kv { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; gap: 8px; align-items: center; }
.kv .head { font-size: 12px; color: var(--text-3); font-weight: 600; }
.loading { display: flex; gap: 10px; align-items: center; color: var(--text-2); padding: 24px 0; }
.loading .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--brand); animation: spin .7s linear infinite; }
.matrix td { vertical-align: top; }
.matrix td.role { width: 170px; }
.matrix select.input { min-width: 150px; }
.filter-chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; max-width: 260px; padding: 3px 8px; border-radius: 6px; background: var(--brand-soft); color: var(--brand-ink); font: 12px var(--mono); border: 0; cursor: pointer; text-align: left; }
.filter-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inherit { color: var(--text-3); font-style: italic; }

/* ── Sign-in page ────────────────────────────────────────────────────── */
.signin { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: radial-gradient(900px 500px at 15% 10%, rgba(51,144,207,.35), transparent 60%), linear-gradient(160deg, #1c2838, #273449 60%, #2d638c); }
.signin .box { width: 100%; max-width: 410px; background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-lg); padding: 30px 30px 26px; }
.signin .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.signin .logo img { width: 48px; height: 48px; border-radius: 12px; }
.signin .logo b { font-size: 20px; display: block; }
.signin .logo span { color: var(--text-2); font-size: 13px; }
.signin h1 { font-size: 17px; margin: 0 0 6px; }
.signin p { color: var(--text-2); margin: 0 0 18px; }
.signin form { display: flex; flex-direction: column; gap: 10px; }
.signin .error { color: var(--bad); background: var(--bad-soft); border-radius: 8px; padding: 9px 12px; font-size: 13.5px; }
.signin .foot { margin-top: 18px; color: var(--text-3); font-size: 12px; }

/* ── Small screens ───────────────────────────────────────────────────── */
@media (max-width: 1080px) {
  .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split { grid-template-columns: minmax(0, 1fr); }
  .list-panel { position: static; }
  .list-panel .items { max-height: 260px; }
}
@media (max-width: 860px) {
  .topbar .menu-btn { display: inline-flex; }
  .topbar .envfile, .topbar .project { display: none; }
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: fixed; z-index: 35; top: 56px; left: 0; width: 280px; transform: translateX(-100%); transition: transform .18s; box-shadow: var(--shadow-lg); }
  .sidebar.open { transform: none; }
  main { padding: 20px 16px 140px; }
  .field { grid-template-columns: minmax(0, 1fr); }
  .grid-2, .grid-3 { grid-template-columns: minmax(0, 1fr); }
  .savebar { left: 12px; right: 12px; bottom: 12px; }
  .page-head { flex-direction: column; }
  .page-head .actions { justify-content: flex-start; }
  .hero { flex-direction: column; align-items: flex-start; }
  .hero .actions { margin-left: 0; }
}
@media (max-width: 520px) {
  .topbar { gap: 8px; padding: 0 10px; }
  .brand .product, .topbar .pill .label { display: none; }
  .topbar .pill { padding: 0 9px; }
}
`;

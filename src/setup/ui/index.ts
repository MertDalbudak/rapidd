import { STYLES } from './styles';
import { installCore } from './core';
import { installComponents } from './components';
import { installStartPages } from './pages/start';
import { installModelPage } from './pages/model';
import { installAccessPage } from './pages/access';
import { installRlsPage } from './pages/rls';
import { installServicesPage } from './pages/services';
import { installRateLimitsPage } from './pages/ratelimits';
import { installReviewPage } from './pages/review';

/**
 * The wizard's pages. The browser code is written as functions in TypeScript files (checked
 * and compiled with the app) and shipped as their source: each install function is
 * serialized with Function.toString into one inline script — no bundler, no external
 * resources, and a strict CSP (nonce) applies.
 *
 * Install order is navigation order: pages register themselves as they are installed.
 */
const MODULES: ((R: unknown) => void)[] = [
    installCore,
    installComponents,
    installStartPages,
    installModelPage,
    installAccessPage,
    installRlsPage,
    installServicesPage,
    installRateLimitsPage,
    installReviewPage,
];

/** Navigation order differs from install order where pages depend on helpers of others */
const NAV_ORDER = ['overview', 'database', 'model', 'signin', 'admin', 'access', 'rls', 'ratelimits', 'services', 'environment', 'review'];

/** The script of the wizard page */
export function wizardScript(): string {
    return [
        '"use strict";',
        // tsx / esbuild (npm run dev) keeps function names with __name(fn, "name") — a no-op here
        'var __name = function (f) { return f; };',
        'var R = {};',
        ...MODULES.map((install) => `(${install.toString()})(R);`),
        `R.pages.sort(function (a, b) { var o = ${JSON.stringify(NAV_ORDER)}; return o.indexOf(a.id) - o.indexOf(b.id); });`,
        'R.start();',
    ].join('\n');
}

let _script: string | null = null;

function document(nonce: string, title: string, body: string, script?: string): string {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
        + `<title>${title}</title><link rel="icon" href="/setup/assets/logo.png">`
        + `<script nonce="${nonce}">try{var t=localStorage.getItem('rapidd-setup-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>`
        + `<style nonce="${nonce}">${STYLES}</style></head><body>${body}`
        + (script ? `<script nonce="${nonce}">${script}</script>` : '')
        + '</body></html>';
}

export function wizardPage(nonce: string): string {
    _script ??= wizardScript();
    return document(nonce, 'Rapidd setup',
        '<div id="app"><noscript><p>The setup wizard needs JavaScript.</p></noscript></div>',
        _script);
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function passwordPage(nonce: string, error?: string): string {
    return document(nonce, 'Rapidd setup — sign in',
        '<div class="signin"><div class="box">'
        + '<div class="logo"><img src="/setup/assets/logo.png" alt=""><div><b>Rapidd</b><span>Setup</span></div></div>'
        + '<h1>Sign in to the setup</h1>'
        + '<p>Enter the setup password from the server console — or open the link printed there.</p>'
        + (error ? `<div class="error" role="alert">${escape(error)}</div>` : '')
        + '<form method="get" action="/setup">'
        + '<label class="sr-only" for="password">Setup password</label>'
        + '<input class="input" id="password" type="password" name="password" autocomplete="off" autofocus placeholder="Setup password" required>'
        + '<button class="btn primary block" type="submit">Continue</button>'
        + '</form>'
        + '<div class="foot">The password changes at every start unless SETUP_PASSWORD is set.</div>'
        + '</div></div>');
}

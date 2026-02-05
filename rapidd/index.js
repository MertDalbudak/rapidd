require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Set framework paths before any module that depends on them
const ROOT = path.resolve(__dirname, '..');
process.env.ROOT = process.env.ROOT || ROOT;
process.env.ROUTES_PATH = process.env.ROUTES_PATH || path.join(ROOT, 'routes');
process.env.STRINGS_PATH = process.env.STRINGS_PATH || path.join(ROOT, 'strings');
process.env.PUBLIC_PATH = process.env.PUBLIC_PATH || path.join(ROOT, 'public');
process.env.PUBLIC_STATIC = process.env.PUBLIC_STATIC || path.join(process.env.PUBLIC_PATH, 'static');
process.env.TEMPLATE_PATH = process.env.TEMPLATE_PATH || path.join(process.env.PUBLIC_PATH, 'template');
process.env.TEMPLATE_LAYOUT_PATH = process.env.TEMPLATE_LAYOUT_PATH || path.join(process.env.TEMPLATE_PATH, 'layout');

// Dependencies
const express = require('express');
require('express-async-errors');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const csrf = require('csurf');

// Framework modules
const { Api, ErrorResponse, apiMiddleware } = require('../src/Api');
const { ejsMiddleware } = require('../lib/ejsRender');
const pushLog = require('../lib/pushLog');
const { authenticate } = require('./auth');
const { setRLSContext } = require('./rls');

// Config
const NODE_ENV = process.env.NODE_ENV;
const ALLOWED_LANGUAGES = require('../config/app').languages;
const SUPPORTED_LANGUAGES = fs.readdirSync(process.env.STRINGS_PATH).map(e => path.parse(e).name);

const COOKIE_OPTIONS = {
    path: '/',
    signed: true,
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'strict'
};

// ─── Express App ─────────────────────────────────────────

const app = express();
app.set('case sensitive routing', true);

if (NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// ─── Static & Body Parsing ──────────────────────────────

app.use(express.static(process.env.PUBLIC_STATIC));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET));

// ─── CORS ───────────────────────────────────────────────

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(e => e.trim());

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.find(e => origin.endsWith(e))) {
            return callback(null, true);
        }
        return callback(new ErrorResponse(403, 'cors_blocked', { origin }), false);
    },
    preflightContinue: false
};

app.use(cors(NODE_ENV === 'production' ? corsOptions : { origin: '*' }));

// ─── CSRF ───────────────────────────────────────────────

app.use(csrf({ cookie: true }));
app.use(function (err, req, res, next) {
    if (req.path.startsWith('/api')) return next();
    if (err.code === 'EBADCSRFTOKEN') return res.status(403).end();
    next(err);
});

// ─── Security Headers ──────────────────────────────────

app.use(function (req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "font-src 'self'"
    );
    if (NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// ─── Language & User Context ────────────────────────────

/**
 * Parse Accept-Language header and return the best matching language
 * @param {string} headerValue - Accept-Language header
 * @returns {string} Matched language code
 */
function resolveLanguage(headerValue) {
    const defaultLang = ALLOWED_LANGUAGES.find(allowed =>
        SUPPORTED_LANGUAGES.find(avail => avail.toLowerCase() === allowed.toLowerCase())
    );

    if (!headerValue || typeof headerValue !== 'string') return defaultLang;

    try {
        const languages = headerValue.toLowerCase()
            .split(',')
            .map(lang => {
                const parts = lang.trim().split(';');
                const code = parts[0].trim();
                const quality = parts[1] ? parseFloat(parts[1].replace('q=', '')) : 1.0;
                return { code, quality };
            })
            .sort((a, b) => b.quality - a.quality);

        // Exact match
        for (const lang of languages) {
            const match = ALLOWED_LANGUAGES.find(a => a.toLowerCase() === lang.code);
            if (match) return match;
        }

        // Language family match (e.g. "en-GB" → "en-US")
        for (const lang of languages) {
            const prefix = lang.code.split('-')[0];
            const match = ALLOWED_LANGUAGES.find(a => a.toLowerCase().startsWith(prefix + '-'));
            if (match) return match;
        }
    } catch (_) { /* fall through to default */ }

    return defaultLang;
}

app.use(function (req, res, next) {
    req.language = req.signedCookies['lang'] || resolveLanguage(req.headers['accept-language'] || '');
    req.user = null;
    next();
});

// ─── Template & API Middleware ──────────────────────────

app.use(ejsMiddleware({
    template_path: process.env.TEMPLATE_LAYOUT_PATH,
    dictionary_path: process.env.STRINGS_PATH,
    default_language: 'root'
}));

app.use(apiMiddleware());

// ─── Request Logging ────────────────────────────────────

app.all('/*', function (req, res, next) {
    req.remoteAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    req.remoteAddressAnonym = req.remoteAddress.substring(0, req.remoteAddress.lastIndexOf('.'));
    pushLog(`${req.method}: ${req.url} from: ${req.remoteAddress}`, 'Incoming', 'request');
    next();
});

// ─── Language Switch ────────────────────────────────────

app.post('/lang/:lang', function (req, res) {
    let lang = req.params.lang;
    if (lang) {
        lang = ALLOWED_LANGUAGES.find(e => e === lang.replace('/', '')) || ALLOWED_LANGUAGES[0];
        res.cookie('lang', lang, COOKIE_OPTIONS);
        res.redirect(302, req.query['redirect'] || '/');
    } else {
        res.redirect('/');
    }
});

// ─── Auth & RLS ─────────────────────────────────────────

app.use(authenticate());
app.use(setRLSContext);

// ─── Route Loading ──────────────────────────────────────

function loadRoutes(routePath) {
    const relativePath = '/' + path.relative(process.env.ROUTES_PATH, routePath).replace('\\', '/');
    const entries = fs.readdirSync(routePath, { withFileTypes: true })
        .sort((a, b) =>
            (a.name === 'root.js' ? -2 : a.isDirectory() ? 0 : -1) -
            (b.name === 'root.js' ? -2 : b.isDirectory() ? 0 : -1)
        );

    for (const entry of entries) {
        if (entry.isDirectory()) {
            loadRoutes(path.join(routePath, entry.name));
        } else if (path.extname(entry.name) === '.js' && entry.name[0] !== '_') {
            const route = entry.name === 'root.js'
                ? relativePath
                : `${relativePath.length > 1 ? relativePath : ''}/${path.parse(entry.name).name}`;
            app.use(route, require(path.join(routePath, entry.name)));
        }
    }
}

loadRoutes(process.env.ROUTES_PATH);

// ─── 404 & Error Handling ───────────────────────────────

app.all('*', (req, res) => {
    res.ejsRender('error.ejs', { error_code: 404 }).then(file => {
        res.status(404).send(file);
    }).catch(error => {
        res.status(500).send(error.toString());
    });
});

app.use((error, req, res, next) => {
    const status = error.status_code || 500;
    console.error(error);

    if (error instanceof ErrorResponse) {
        return res.status(status).json(error.toJSON(req.language));
    }

    const message = Object.getPrototypeOf(error).constructor === Error && NODE_ENV === 'production'
        ? 'Something went wrong'
        : (error.message || error.toString());

    pushLog(message, status);
    return res.status(status).json(Api.errorResponseBody(status, message));
});

// ─── Finalize ───────────────────────────────────────────

app.disable('x-powered-by');

module.exports = app;

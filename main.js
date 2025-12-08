// LOAD CONFIG FILE
require('dotenv').config();

// REQUIRE DEPENDECIES
const fs = require('fs');
const path = require('path');
const express = require('express');
require("express-async-errors");
const cookieParser = require('cookie-parser');
const cors = require('cors');
const csrf = require('csurf');
//const fileUpload = require('express-fileupload');

// SET CONST VARIABLE
const NODE_ENV = process.env.NODE_ENV;

// SET PROCESS ENV VARIABLES
process.env.ROOT = path.resolve(__dirname);
process.env.ROUTES_PATH = path.join(process.env.ROOT, "routes");
process.env.STRINGS_PATH = path.join(process.env.ROOT, "strings");
process.env.PUBLIC_PATH = path.join(process.env.ROOT, "public");
process.env.PUBLIC_STATIC = path.join(process.env.PUBLIC_PATH, "static");
process.env.TEMPLATE_PATH = path.join(process.env.PUBLIC_PATH, "template");
process.env.TEMPLATE_LAYOUT_PATH = path.join(process.env.TEMPLATE_PATH, "layout");

// LOAD MIDDLEWARES AFTER SETTING PATHS
//require('./middleware/model')

// REQUIRE CUSTOM DEPENDENCIES
const {Api, ErrorResponse, apiMiddleware} = require('./src/Api');
const {ejsMiddleware} = require('./lib/ejsRender');
const pushLog = require('./lib/pushLog');
const { authenticateUser } = require('./rapidd/auth');
const { setRLSContext } = require('./rapidd/rls');

const ALLOWED_LANGUAGES = require('./config/app').languages;
const SUPPORTED_LANGUAGES = fs.readdirSync(process.env.STRINGS_PATH).map(e => path.parse(e).name);
const COOKIE_OPTIONS = {
    'path': "/",
    'signed': true,
    'httpOnly': true,
    'secure': NODE_ENV == "production",
    'sameSite': "strict"
};

const CSRF_OPTIONS = { cookie: true };

const app = express();
app.set('case sensitive routing', true);

// TRUST PROXY WHEN PRODUCTION
if (NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

/**
 * Gets the first accepted language from Accept-Language header
 * Parses format: en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7
 * @param {string} remote_lang Language header value
 * @return {string} Matched language code
 * @public
 */
function acceptedLanguage(remote_lang){
    // Get default language (first allowed language that exists in supported languages)
    const _default = ALLOWED_LANGUAGES.find(allowed =>
        SUPPORTED_LANGUAGES.find(available => available.toLowerCase() === allowed.toLowerCase())
    );

    if(!remote_lang || typeof remote_lang !== 'string') {
        return _default;
    }

    try {
        // Parse Accept-Language header: "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7"
        const languages = remote_lang.toLowerCase()
            .split(',')
            .map(lang => {
                const parts = lang.trim().split(';');
                const code = parts[0].trim();
                const quality = parts[1] ? parseFloat(parts[1].replace('q=', '')) : 1.0;
                return { code, quality };
            })
            .sort((a, b) => b.quality - a.quality); // Sort by quality value (highest first)

        // Try exact match first (e.g., "en-US" matches "en-US")
        for(const lang of languages) {
            const exactMatch = ALLOWED_LANGUAGES.find(allowed =>
                allowed.toLowerCase() === lang.code
            );
            if(exactMatch) {
                pushLog(`Matched exact language: ${exactMatch}`, 'Remote', 'request');
                return exactMatch;
            }
        }

        // Try language family match (e.g., "en-GB" matches "en-US" if "en-GB" not available)
        for(const lang of languages) {
            const langPrefix = lang.code.split('-')[0]; // Get "en" from "en-US"
            const familyMatch = ALLOWED_LANGUAGES.find(allowed =>
                allowed.toLowerCase().startsWith(langPrefix + '-')
            );
            if(familyMatch) {
                pushLog(`Matched language family: ${familyMatch} for ${lang.code}`, 'Remote', 'request');
                return familyMatch;
            }
        }

        pushLog(`No matching language found in Accept-Language header. Using default: ${_default}`, 'Remote', 'request');
    } catch(error) {
        pushLog(`Error parsing Accept-Language header: ${error.message}. Using default: ${_default}`, 'Remote', 'request');
    }

    return _default;
}

app.use(express.static(process.env.PUBLIC_STATIC));

app.use(express.urlencoded({
    extended: true
}));

// USE CORS

const allowed_origins = process.env.ALLOWED_ORIGINS.split(',').map(e => e.trim());

const corsOptions = {
    'origin': (origin, callback) => {
        if (!origin || allowed_origins.find(e => origin.endsWith(e))) {
            return callback(null, true);
        }
        else {
            return callback(new ErrorResponse(403, "cors_blocked", {origin}), false);
        }
    },
    'preflightContinue': false
};

app.use(cors(NODE_ENV === "production" ? corsOptions : { origin: '*' }));

// USE JSON PARSE MIDDLEWARE
app.use(express.json());
// USE COOKIE-PARSER MIDDLEWARE
app.use(cookieParser(process.env.COOKIE_SECRET));
// USE CSRF MIDDLEWARE

app.use(csrf(CSRF_OPTIONS));
app.use(function(err, req, res, next) {
    if (req.path.startsWith('/api')) {
        return next();
    }
    console.error(err);
    // Handle CSRF token errors
    if (err.code === 'EBADCSRFTOKEN') {
        // Respond with a 403 Forbidden status for CSRF token errors
        return res.status(403).end();
    }
    // For other errors, pass them to the next middleware
    next(err);
});

/////////// SECURITY HEADERS MIDDLEWARE ///////////

app.use(function(req, res, next){
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Content Security Policy
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "font-src 'self'"
    );

    // HTTPS enforcement in production
    if (NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
});

/////////// CUSTOM MIDDLEWARE ///////////

app.use(async function(req, res, next){
    //////////// SET LANGUAGE //////////// 
    
    req.language = req.signedCookies['lang'] || acceptedLanguage(req.headers['accept-language'] || "");

    /////// LOGGED IN USER ///////
    req.user = null;
    
    next();
});

///////////// EJS RENDER /////////////

app.use(ejsMiddleware({
    'template_path': process.env.TEMPLATE_LAYOUT_PATH,
    'dictionary_path': process.env.STRINGS_PATH,
    'default_language': "root"
}));

///////////// EJS RENDER /////////////

///////////// API MIDDLEWARE /////////////

app.use(apiMiddleware());

///////////// API MIDDLEWARE /////////////


/////////////// ROUTER ///////////////

app.all('/*', async (req, res, next) => {
    req.remoteAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    req.remoteAddressAnonym = req.remoteAddress.substring(0, req.remoteAddress.lastIndexOf('.'));
    pushLog(`${req.method}: ${req.url} from: ${req.remoteAddress}`, "Incoming", "request");
    
    next();
});

app.post('/lang/:lang', function(req, res){
    let lang = req.params.lang;
    if(lang){
        lang = ALLOWED_LANGUAGES.find(e => e == lang.replace('/', '')) || ALLOWED_LANGUAGES[0];
        res.cookie('lang', lang, COOKIE_OPTIONS);
        res.redirect(302, req.query['redirect'] || '/');
    }
    else {
        res.redirect('/');
    }
});

app.use(authenticateUser);
app.use(setRLSContext);

// LOAD ALL ROUTERS IN /routes
function init_router_directory(route_path){
    const relative_path = '/' + path.relative(process.env.ROUTES_PATH, route_path).replace('\\', '/');
    // LOAD ALL ROUTERS IN DIRECTORY, root.js ALWAYS COMES FIRST
    const dir_content = fs.readdirSync(route_path, {withFileTypes: true}).sort((a, b)=> (a.name == 'root.js' ? -2 : a.isDirectory() ? 0 : -1) - (b.name == 'root.js' ? -2 : b.isDirectory() ? 0 : -1))
    dir_content.forEach(function(file) {
        if(!file.isDirectory()){
            if(path.parse(file.name).ext == ".js" && file.name.slice(0,1) != '_'){
                const route = file.name == "root.js" ? relative_path : `${relative_path.length > 1 ? relative_path : ''}/${path.parse(file.name).name}`;             
                app.use(route, require(path.join(route_path, file.name)));
            }
        }
        else{
            init_router_directory(path.join(route_path, file.name));
        }
    });
}

init_router_directory(process.env.ROUTES_PATH);

// SENT 404 PAGE NOT FOUND
app.all('*', (req, res)=>{
    res.ejsRender('error.ejs', {'error_code': 404}).then((file)=>{
        res.status(404).send(file);
    }).catch((error)=> {
        res.status(500).send(error.toString());
    });
});

// DEFAULT ERROR HANDLER
app.use((error, req, res, next) => {
    const status = error.status_code || 500;
    console.error(error);
    
    let message;
    if (error instanceof ErrorResponse) {
        return res.status(status).json(error.toJSON(req.language));
    } else {
        message = Object.getPrototypeOf(error).constructor === Error && NODE_ENV === "production" ? "Something went wrong" : (error.message || error.toString());
    }

    pushLog(message, status);
    return res.status(status).json(Api.errorResponseBody(status, message));
});

/////////////// ROUTER ///////////////

app.disable('x-powered-by');
const server = app.listen(process.env.PORT, () => pushLog('Application running on port ' + process.env.PORT, "Server start"));

module.exports = server;
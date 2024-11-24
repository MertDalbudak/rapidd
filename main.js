// LOAD CONFIG FILE
require('dotenv').config();

// REQUIRE DEPENDECIES
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors')
const csrf = require('csurf');
const fileUpload = require('express-fileupload');

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

// REQUIRE CUSTOM DEPENDENCIES
const {ejsMiddleware} = require('./lib/ejsRender');
const pushLog = require('./lib/pushLog');

const ALLOWED_LANGUAGES = require('./config/app').languages;
const SUPPORTED_LANGUAGES = fs.readdirSync(process.env.STRINGS_PATH).map(e => path.parse(e).name);
const FILE_NAME_LENGTH = 32;
const COOKIE_OPTIONS = {
    'path': "/",
    'signed': true,
    'httpOnly': true,
    'secure': NODE_ENV == "production",
    'sameSite': "strict"
};
const SESSION_OPTIONS = {
    'name': "usid",
    'resave': false,
    'saveUninitialized': false,
    'secret': SESSION_SECRET,
    'cookie': {
        'path': "/",
        'maxAge': SESSION_MAX_AGE,
        'expires': new Date(Date.now() + SESSION_MAX_AGE),
        'httpOnly': true, 
        'secure': NODE_ENV == "production",
        'sameSite': "strict"
    },
    'store': require('./src/Model/Session')(session.Store)
};
const CSRF_OPTIONS = { cookie: true };

const app = express();
app.set('case sensitive routing', true);

/**
 * Gets the first accepted language
 * @param {string} remote_lang Language
 * @return {Object}
 * @public
 */
function acceptedLanguage(remote_lang){
    remote_lang = remote_lang.toLowerCase();
    const _default = ALLOWED_LANGUAGES.find(allowed => SUPPORTED_LANGUAGES.find(available => available.toLowerCase() == allowed.toLowerCase()));
    try{
        remote_lang = remote_lang.split(',').map(s => s.substr(0, 2));
        for(let i = 0; i < remote_lang.length; i++){
            const lang = ALLOWED_LANGUAGES.find(e => e.substr(0, 2).toLowerCase() == remote_lang[i]);
            if(lang != undefined)
                return lang;
        }
        pushLog(`Remote's accepted language is not allowed or not supported.`, 'Remote', 'request');
    }catch {
        pushLog(`Cannot understand remote's accepted language.`, 'Remote', 'request');
    }
    pushLog(`Setting ${_default} as language.`, 'Remote', 'request');
    return _default;
}

app.use(express.static(ROOT + '/public/static'));

app.use(express.urlencoded({
    extended: true
}));

/////////// CORS ///////////

const corsOptions = {
    origin: process.env.FRONTEND_DOMAIN, // Use your frontend domain in production
    optionsSuccessStatus: 200
};

app.use(cors());

// USE JSON PARSE MIDDLEWARE
app.use(express.json());
// USE COOKIE-PARSER MIDDLEWARE
app.use(cookieParser(process.env.COOKIE_SECRET));
// USE CSRF MIDDLEWARE

app.use(csrf(CSRF_OPTIONS));

app.use(function(err, req, res, next) {
    console.error(err);
    if (err.code !== 'EBADCSRFTOKEN') return next(err)

    // handle CSRF token errors here
    res.sendStatus(403);
    res.end();
});

app.use(session(SESSION_OPTIONS));

/////////// CUSTOM MIDDLEWARE ///////////

app.use(async function(req, res, next){
    //////////// SET LANGUAGE ////////////

    req.language = req.signedCookies['lang'] || acceptedLanguage(req.headers['accept-language'] || "");

    //////////// SET LANGUAGE ////////////

    /////// VALIDATE LOGIN STATUS ///////
    req.user = null;
    /////// VALIDATE LOGIN STATUS ///////
    
    next();
});


app.use(fileUpload({
    'useTempFiles' : true,
    'tempFileDir': process.env.ROOT + "/temp/upload/",
    'limits': { 
        'fileSize': 50 * 1024 * 1024    // 50Mbyte
    },
    'preserveExtension': true,
    'abortOnLimit': true
}));

/////////// UPLOAD HANDLER ///////////


///////////// EJS RENDER /////////////

app.use(ejsMiddleware({
    'template_path': process.env.TEMPLATE_LAYOUT_PATH, 
    'dictionary_path': process.env.STRINGS_PATH, 
    'default_language': "de-de"
}));

///////////// EJS RENDER /////////////


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
    else
        res.redirect('/');
});

// LOAD ALL ROUTERS IN /routes
function init_router_directory(route_path){
    const relative_path = '/' + path.relative(process.env.ROUTES_PATH, route_path).replace('\\', '/');
    // LOAD ALL ROUTERS IN DIRECTORY, root.js ALWAYS COMES FIRST
    const dir_content = fs.readdirSync(route_path, {withFileTypes: true}).sort((a, b)=> (a.name == 'root.js' ? -2 : a.isDirectory ? -1 : 0) - (b.name == 'root.js' ? -2 : b.isDirectory ? -1 : 0))
    dir_content.forEach(function(file) {
        if(!file.isDirectory()){
            const route = file.name == "root.js" ? relative_path : `${relative_path.length > 1 ? relative_path : ''}/${path.parse(file.name).name}`;
            
            app.use(route, require(path.join(route_path, file.name)));
            console.log(relative_path + '/' + file.name);
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
    })
});

/////////////// ROUTER ///////////////

app.disable('x-powered-by');
app.listen(process.env.PORT, () => pushLog('Application running on port ' + process.env.PORT, "Server start"));
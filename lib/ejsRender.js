const ejs = require('ejs');

const ROOT = process.env.PWD;
const Helper = require('../src/View/Helper');

/**
 * @param {Object} opts
 * @param {string} [opts.template_path] The path where the templates are located
 * @param {string} [opts.dictionary_path] The path where the dictionaries are located
 * @param {string} [opts.default_dict] The path where the dictionaries are located
 */
exports = module.exports = (opts) => {
    opts.default_dict = opts.default_dict || "root";
    const TEMPLATE_PATH = opts.template_path || ROOT + "/public/template/";
    const LanguageDict = require('./LanguageDict')(opts.dictionary_path, opts.default_dict);

    return (req, res, next) => {
        /**
        * Renders a ejs file. Output will be returned over given callback
        * @param {[content: string, data: {}, options: {delimiter: string, language: string, messages: [{type: string, subject: string, text: string}], root: string}, callback: ejs.RenderFileCallback, template: string]} args 
        * @param {{}} data > Optional
        * @param {{}} options > Optional
        */
        res.ejsRender = (...args) => {
            // OVERLOAD START
            let content = args[0], 
                data = args.length >= 3 ? args[1] : {},
                options = args.length >= 4 ? args[2] : {}, 
                callback = typeof args[args.length -1] == "string" ? args[args.length -2] : args[args.length -1],
                template = typeof args[args.length -1] == "string" ? args[args.length -1] : "default";
            // VALIDATE PROPERTIES
            if(typeof content != "string")
                throw "First parameter expected to be type of string. " + typeof content + " given";
            if(typeof data != "object")
                throw "Second parameter(data) expected to be type of object. " + typeof data + " given";
            if(typeof options != "object")
                throw "Third parameter(options) expected to be type of object. " + typeof options + " given";
            if(typeof callback != "function")
                throw "Third parameter(callback) expected to be type of object. " + typeof callback + " given";
            if(typeof template != "string")
                throw "Fifth parameter(template) expected to be type of object. " + typeof template + " given";
            // VALIDATE PROPERTIES END
            // OVERLOAD END
            const messages = [...(req.messages || []), ...(options.messages || [])];
            const language = options.language || req.language || opts.default_dict;
            const language_dict = new LanguageDict(language);
            const form_security = {
                'csrf': req.csrfToken()
            };
            const ejsData = {
                ...Helper,
                'content': content,
                'data': data,
                'language': language,
                'form_security': form_security,
                'messages': messages,
                'nav_schema': res.nav_schema,
                'path': req.originalUrl,
                'user': req.user || null,
                '__': (...args) => language_dict.get(...args)
            };
            template = TEMPLATE_PATH + "/" + template + ".ejs";
            ejs.renderFile(template, ejsData, {
                'delimiter': options.delimiter || "?",
                'root': options.root || TEMPLATE_PATH
            }, callback);
        }
        next();
    }
}
const ejs = require('ejs');
const fs = require('fs/promises');

const Helper = require('../src/View/Helper');
const pushLog = require('./pushLog');

let git_head = "not available";

// Only try to read git head if ROOT is defined
if (process.env.ROOT) {
    fs.readFile(`${process.env.ROOT}/.git/refs/heads/main`).then((data) => {
        git_head = data;
    }).catch(error => {
        pushLog("Couldn't find git head hash");
    });
}


class ejsRender {
    /**
     * @param {Object} options
     * @param {string} [options.template_path] The path where the templates are located
     * @param {string} [options.dictionary_path] The path where the dictionaries are located
     * @param {string} [options.default_language] Default dictionary
     */
    constructor(options = {}){
        this.template_path = options.template_path || process.env.TEMPLATE_LAYOUT_PATH;
        this.dictionary_path = options.dictionary_path || process.env.STRINGS_PATH;
        this.default_language = options.default_language || "root";
        this.LanguageDict = require('./LanguageDict')(this.dictionary_path, this.default_language);
    }

    /**
    * Renders a ejs file. Output will be returned over given callback
    * @param {string} page 
    * @param {{}} data
    * @param {{delimiter: string, language: string, messages: [{type: string, subject: string, text: string}], root: string}} options
    */
    async render(page, data = {}, options = {}){
        // VALIDATE PROPERTIES
        if(typeof page != "string")
            throw new Error("First parameter expected to be type of string. " + typeof page + " given");
        if(typeof data != "object")
            throw new Error("Second parameter(data) expected to be type of object. " + typeof data + " given");
        if(typeof options != "object")
            throw new Error("Third parameter(options) expected to be type of object. " + typeof options + " given");
        // VALIDATE PROPERTIES END
        const messages = options.messages || [];
        const language = options.language || this.default_language;
        const language_dict = new this.LanguageDict(language);
        const template = `${this.template_path}/${options.template || 'default'}.ejs`;

        const form_security = {
            'csrf': options.csrf_token
        };
        const ejsData = {
            ...Helper,
            'page': page,
            'data': data,
            'language': language,
            'form_security': form_security,
            'messages': messages,
            'nav_schema': options.nav_schema,
            'path': options.original_url,
            'meta': {
                'git_head': git_head
            },
            'user': options.user || null,
            '__': (...args) => language_dict.get(...args)
        };
        
        return new Promise((resolve, reject) => {
            ejs.renderFile(template, ejsData, {
                'delimiter': options.delimiter || "?",
                'root': options.root || this.template_path
            }, function(error, file){
                if(error){
                    reject(error);
                }
                else{
                    resolve(file);
                }
            });
        });
    }
}

/**
 * @param {Object} options
 * @param {string} [options.template_path] The path where the templates are located
 * @param {string} [options.dictionary_path] The path where the dictionaries are located
 * @param {string} [options.default_language] Default dictionary
 */
const ejsMiddleware = (options = {}) => {
    const renderer = new ejsRender({'template_path': options.template_path, 'dictionary_path': options.dictionary_path, 'default_language': options.default_language || "root"})

    return (req, res, next) => {
        /**
        * Renders a ejs file. Output will be returned over given callback
        * @param {string} page 
        * @param {{}} data
        * @param {{delimiter: string, language: string, messages: [{type: string, subject: string, text: string}], root: string}} options
        */
        res.ejsRender = async (page, data = {}, options = {}) => {
            options.messages = [...(req.messages || []), ...(options.messages || [])];
            options.language = options.language || req.language;
            //options.csrf_token = req.csrfToken();
            options.original_url = req.originalUrl;
            options.nav_schema = res.nav_schema;
            options.user = req.user;

            const file = await renderer.render(page, {...data, 'browser': true}, options);
            return file;
        }
        next();
    }
}

module.exports = {ejsRender, ejsMiddleware};
// PUT ALL YOUR HELPERS HERE
const { ErrorResponse } = require('../Api');
const LanguageDict = require('../../lib/LanguageDict');
const {default_timezone} = require('../../config/app.json') || "Europe/Berlin";

const Helper = {};

Helper.greet = function(name){
    return `Hello ${name}!`;
};

Helper.debug = function(data){
    let debug_string;
    switch(typeof data){
        case 'number':
        case 'string':
        case 'boolean':
            debug_string = data;
        case 'object':
            data = JSON.stringify(data, null, 4);
            debug_string = data.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
                var cls = 'number';
                if (/^"/.test(match)) {
                    if (/:$/.test(match)) {
                        cls = 'key';
                    } else {
                        cls = 'string';
                    }
                } else if (/true|false/.test(match)) {
                    cls = 'boolean';
                } else if (/null/.test(match)) {
                    cls = 'null';
                }
                return '<span class="' + cls + '">' + match + '</span>';
            });
    }
    return `<pre class="debug _select">${debug_string}</pre>`;
};

Helper.langShort = function(lang){
    return lang != "root" ? lang.substr(0, 2) : "en";
};

Helper.form = function(options){
    return `<div style="display:none;">${Helper.csrf(options.csrf)}</div>`;
};

Helper.csrf = function(csrfToken){
    return `<input type="hidden" name="_csrf" value="${csrfToken}" autocomplete="off" />`;
};
/**
 * 
 * @param {'success'|'warn'|'error'} type 
 * @param {String} subject 
 * @param {String} text 
 * @returns {String}
 */
Helper.message = function(type, text){
    return `<div class="msg ${type}"><span>${text}</span></div>`;
}

/**
 * 
 * @param {String} content
 */
Helper.getPageName = (page) =>{
    if(typeof page == "string"){
        return page.split('.')[0];
    }
    throw new ErrorResponse(`String expected, ${typeof content} given.`, 400);
}

Helper.addToClipboard = (content) => `<a href="javascript:addToClipboard('${content}')" class="addToClipboard" title="Copy to clipboard"></a>`;

Helper.moment = require('moment-timezone');
Helper.moment.tz.setDefault(default_timezone);

module.exports = Helper;
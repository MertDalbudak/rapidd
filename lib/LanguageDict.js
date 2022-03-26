const {readdir, writeFile} = require('fs/promises');;
const path = require('path');

const STRINGS_PATH = "../strings";
/**
 * 
 * @param {string} dictionary_path 
 * @param {string} default_dict 
 * @returns {LanguageDict}
 */
module.exports = function(dictionary_path = STRINGS_PATH, default_dict = "root"){
    class LanguageDict {
        /**
         * Selects a dictionoary by name
         * @param {string} name 
         */
        constructor(name){
            this.name = name;
            this.dict = LanguageDict.get(this.name);
        }
    
        /**
         * 
         * @param {string} key 
         * @param {{}|null} data 
         */
        get(key, data = null){
            let translated = this.dict[key];
            // TRANSLATION FOUND
            if(translated != undefined){
                // REPLACE STRING IF DATA IS SET
                if(data != null && typeof data == 'object'){
                    translated = translated.replace(/\{(\w+)\}/g, r => data[r.slice(1, -1)]);
                }
                return translated;
            }
            else
                return key;
        }
    
        /**
         * Adds a new LanguageDictionary and stores it on the drive
         * @param {string} name 
         * @param {Object} dict
         * @param {Boolean} force
         */
        static async add(name, dict, force = false){
            if(path.extname == "")
                this.name = name + ".json";
            else
                this.name = name;
            // CHECK IF ALREADY EXISTS
            if(LANGUAGE_DICTS[path.parse(filename).name] != undefined && force){
                console.error("Dictionary for this language already exists. Force needs to be true to overwrite.")
            }
            this.dict = dict;
            if(typeof dict == "object")
                this.dict_string = JSON.stringify(this.dict);
            else{
                console.error("Second parameter must be an object");
                return null;
            }
            await fs.writeFile(LanguageDict.dictionary_path + this.name, this.dict_string, {'encoding': "utf8"});
            LanguageDict.all[name] = dict;
        }
    
        /**
         * 
         * @param {string} name
         * @return {{}|null} Returns 
         */
        static get(name){
            return LanguageDict.all[name] || LanguageDict.all[LanguageDict.default] || {};
        }
    };
    
    
    LanguageDict.all = {};
    LanguageDict.available = [];
    LanguageDict.dictionary_path = dictionary_path + '/';
    LanguageDict.default = default_dict || "root";
    
    
    // LOAD ALL DICTIONARIES
    readdir(LanguageDict.dictionary_path).then((file_names) => file_names.forEach(function(file_name) {
        const name = path.parse(file_name).name;
        LanguageDict.all[name] = require(LanguageDict.dictionary_path + file_name);
        LanguageDict.available.push(name);
    }));
    
    return LanguageDict;
}
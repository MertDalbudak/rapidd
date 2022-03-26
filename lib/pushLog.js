const { appendFile } = require('fs/promises');

const ROOT = process.env.PWD;
const TAB_SIZE = 4;
const CODE_TAB_COUNT = 5;
const LOG_PATH = ROOT + "/logs/";

/**
 * Logs a
 * @param {string} msg 
 * @param {string} code 
 * @param {'request'|'sql'|'system'|'debug'} file 
 * @public
 */
const pushLog = async function (msg, code = "System", file = "system") {
    if(typeof msg == 'object')
        msg = JSON.stringify(msg);
    const tabs = '\t'.repeat(CODE_TAB_COUNT - parseInt(code.toString().length / TAB_SIZE));
    let log_entry = `${new Date()}\t${code}${tabs}${msg}\r\n`;
    console.log(log_entry);
    await appendFile(`${LOG_PATH}${file}.log`, log_entry, {'encoding': "utf-8"});
}

module.exports = pushLog;
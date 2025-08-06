const { appendFile } = require('fs/promises');

const ROOT = process.env.ROOT;
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
const pushLog = async function (msg, code = "system", file = "system") {
    console.log(msg);
    if(typeof msg == 'object')
        msg = JSON.stringify(msg);
    const tabs_count = Math.max(CODE_TAB_COUNT - parseInt(code.toString().length / TAB_SIZE), 0);
    const tabs = '\t'.repeat(tabs_count);
    let log_entry = `${new Date()}\t${code}${tabs}${msg.toString()}\r\n`;
    await appendFile(`${LOG_PATH}${file}.log`, log_entry, {'encoding': "utf-8"});
}

module.exports = pushLog;
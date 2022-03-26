const sqlQuery = require('../../lib/sqlQuery');


module.exports = function (Store) {
    class SessionStore extends Store {
        constructor(options = {}){
            super(options);
        }
        /**
         * Get all sessions
         * @param {listSessionCallback} callback callback(error, sessions)
         */
        all(callback){
            sqlQuery(
                `SELECT s.sid, s.cookie, s.login_session_id, l.user_id, u.email, u.contact_id, u.active, u.confirmed, l.ip_address, l.user_agent FROM sessions AS s 
                LEFT JOIN login_sessions AS l ON l.unique_id = s.login_session_id 
                LEFT JOIN users AS u ON u.unique_id = l.user_id`
            ).then((data)=>{
                for(let i = 0; i < data.length; i++)
                    data[i]['cookie'] = JSON.parse(data[i]['cookie']);
                callback(null, data);
            }).catch(error => {
                callback(error, null);
            });
        }

        /**
         * 
         * @param {voidSessionCallback} callback 
         */
        destroy(sid, callback){
            sqlQuery({
                'query': "DELETE FROM `sessions` WHERE sid = ? LIMIT 1",
                'data': [sid]
            }).then(()=>{
                callback(null);
            }).catch(error => {
                callback(error);
            });
        }

        /**
         * 
         * @param {voidSessionCallback} callback 
         */
        clear(callback){
            sqlQuery("DELETE FROM `sessions`").then(()=>{
                callback(null);
            }).catch(error => {
                callback(error);
            });
        }

        /**
         * 
         * @param {lengthSessionCallback} callback 
         */
        length(callback){
            sqlQuery("SELECT count(unique_id) AS amount FROM `sessions`").then((data)=>{
                callback(null, data.amount);
            }).catch(error => {
                callback(error, null);
            });
        }
        /**
         * Gets Sessions
         * @param {getSessionCallback} callback 
         */
        get(sid, callback){
            sqlQuery({
                'query': `SELECT s.sid, s.cookie, s.login_session_id, l.user_id, u.email, u.contact_id, u.active, u.confirmed, l.ip_address, l.user_agent FROM sessions AS s 
                LEFT JOIN login_sessions AS l ON l.unique_id = s.login_session_id 
                LEFT JOIN users AS u ON u.unique_id = l.user_id 
                WHERE s.sid = ? LIMIT 1`,
                'data': [sid]
            }).then((data)=>{
                if(data.length > 0){
                    try {
                        data[0]['cookie'] = JSON.parse(data[0]['cookie']);
                    }catch(error){
                        callback(error, null);
                    }
                    data[0]['user'] = {
                        'unique_id': data[0]['user_id'],
                        'email': data[0]['email'],
                        'contact_id': data[0]['contact_id'],
                        'active': data[0]['active'],
                        'confirmed': data[0]['confirmed']
                    };
                    delete data[0]['user_id'];
                    delete data[0]['email'];
                    delete data[0]['contact_id'];
                    delete data[0]['active'];
                    delete data[0]['confirmed'];
                    callback(null, data[0]);
                }
                else
                    callback(null, null);
            }).catch(error => {
                callback(error, null);
            });
        }

        /**
         * 
         * @param {voidSessionCallback} callback 
         */
        set(sid, session, callback){
            // CLONE SESSION
            session = {...session};

            // STRINGIFY COOKIE
            session['cookie'] = JSON.stringify(session['cookie']);

            let schema;

            // ALLOWED FIELD NAMES TO BE SET
            let options = {
                'login_sessions': ['ip_address', 'user_agent'],
                'sessions': ['cookie', 'login_session_id']
            };
            // SPECIFY THE KEYS WHICH WILL BE PASSED TO THE SQL QUERY
            let optional_keys = {
                'login_sessions': options['login_sessions'].filter(e => session[e] != undefined),
                'sessions': options['sessions'].filter(e => session[e] != undefined)
            };
            // SPECIFY THE KEY VALUES WHICH WILL BE PASSED TO THE SQL QUERY
            let optional_values = {
                'login_sessions': optional_keys['login_sessions'].map(e => session[e]),
                'sessions': optional_keys['sessions'].map(e => session[e])
            };
            // THE MODIFICATION
            let fields = {
                'login_sessions': ',' + optional_keys['login_sessions'].join(','),
                'sessions': ',' + optional_keys['sessions'].join(','),
            };

            // CREATE NEW SESSION AS LOGGED IN USER
            if(typeof session.user_id != undefined){
                schema = [
                    {
                        'query': "INSERT INTO `login_sessions` (user_id" + fields['login_sessions'] + ") VALUES (?" + (", ?").repeat(optional_keys['login_sessions'].length) + ")",
                        'data': [session.user_id, ...optional_values['login_sessions']]
                    },
                    {
                        'query': "INSERT INTO `sessions` (sid, login_session_id" + fields['sessions'] + ") VALUES (?, ?" + (", ?").repeat(optional_keys['sessions'].length) + ")",
                        'data': [sid, '{{0}}', ...optional_values['sessions']]
                    }
                ];
            }
            else{
                schema = {
                    'query': "INSERT INTO `sessions` (sid" + fields['sessions'] + ") VALUES (?" + (", ?").repeat(optional_keys['sessions'].length) + ")",
                    'data': [sid, ...optional_values['sessions']]
                };
            }
            sqlQuery(schema).then((data)=>{
                callback(null);
            }).catch(error => {
                callback(error);
            });
        }

        /**
         * 
         * @param {voidSessionCallback} callback 
         */
        touch(sid, session, callback){
            session['cookie'] = JSON.stringify(session['cookie']);
            let options = ['cookie', 'login_session_id'];
            let optional_keys = options.filter(e => session[e] != undefined);
            let optional_values = optional_keys.map(e => session[e]);
            let fields = optional_keys.map(e => `${e} = ?`).join(',');
            sqlQuery({
                'query': `UPDATE sessions SET ${fields} WHERE sid = ?`,
                'data': [...optional_values, sid]
            }).then(()=>{
                callback(null);
            }).catch(error => {
                callback(error);
            });
        }
    };
    return new SessionStore();
}


/**
 * List Session Function
 * @callback listSessionCallback
 * @param {*} error
 * @param {Array} sessions
*/
/**
 * Void Session Function
 * @callback voidSessionCallback
 * @param {*} error
*/
/**
 * Length Session Function
 * @callback lengthSessionCallback
 * @param {*} error
 * @param {number} len
*/
/**
 * Get Session Function
 * @callback getSessionCallback
 * @param {*} error
 * @param {Object} session
*/
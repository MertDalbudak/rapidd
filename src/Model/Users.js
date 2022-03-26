const sqlQuery = require('../../lib/sqlQuery');
const Users = {};

/**
 * Gets user by it's  unique_id
 * @param {Number|String} unique_id
 * @return {Promise} User
 * @public
 */
Users.get = async (unique_id) => {
    const users = await sqlQuery({
        'query': "SELECT * FROM `users` WHERE `unique_id` = ?",
        'data': [unique_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    if(users.length == 0)
        return null;
    return users[0];
};

/**
 * Gets all users
 * @return {Promise} Users
 * @public
 */
Users.getAll = async ()=> {
    const users = await sqlQuery("SELECT * FROM `users`").catch(error => {
        return Promise.reject(error);
    });
    return users;
};

/**
 * Creates a new user
 * @param {Number|String} contact_id
 * @param {String} hash
 * @param {Boolean} active
 * @param {Boolean} confirmed
 * @return {Promise} User
 * @public
 */
Users.create = async (contact_id, hash, active = 1, confirmed = 0) => {
    const user = await sqlQuery({
        'query': "INSERT INTO `users` (contact_id, hash, active, confirmed) VALUES (?, ?, ?, ?, ?)",
        'data': [contact_id, hash, active, confirmed]
    }).catch(error => {
        return Promise.reject(error);
    });
    return user;
};

/**
 * Gets user by it's  unique_id
 * @param {Number|String} unique_id
 * @param {{}} data
 * @return {Promise} User
 * @public
 */
Users.update = async (unique_id, data) => {
    let options = ['contact_id', 'email', 'hash', 'active', 'confirmed'];
    let optional_keys = options.filter(e => data.hasOwnProperty(e));
    let optional_values = optional_keys.map(e => data[e]);
    let fields = optional_keys.map(e => `${e} = ?`).join(',');
    const user = await sqlQuery({
        'query': `UPDATE users SET ${fields} WHERE unique_id = ?`,
        'data': [...optional_values, unique_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    return user;
};

/**
 * Gets all active or not active users
 * @param {Boolean} flag
 * @return {Promise} User
 * @public
 */
Users.getActive = async (flag = true) => {
    const users = await sqlQuery({
        'query': "SELECT * FROM `users` WHERE `active` = ?",
        'data': [flag ? 1 : 0]
    }).catch(error => {
        return Promise.reject(error);
    });
    return users;
};

/**
 * Gets all active or not confirmed users
 * @param {Boolean} flag
 * @return {Promise} User
 * @public
 */
Users.getConfirmed = async (flag = true) => {
    const users = await sqlQuery({
        'query': "SELECT * FROM `users` WHERE `confirmed` = ?",
        'data': [flag ? 1 : 0]
    }).catch(error => {
        return Promise.reject(error);
    });
    return users;
};

/**
 * Gets user by it's  contact_id
 * @param {Number|String} contact_id Contact ID
 * @return {Promise} User
 * @public
 */
Users.getByContactId = async (contact_id) => {
    const users = await sqlQuery({
        'query': "SELECT * FROM `users` WHERE `contact_id` = ?",
        'data': [contact_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    if(users.length == 0)
        return null;
    return users[0];
};

/**
 * Gets users list of failed logins
 * @param {Number|String} unique_id
 * @return {Promise} User
 * @public
 */
Users.getFailedLogins = async (user_id) => {
    const failedList = await sqlQuery({
        'query': "SELECT * FROM `failed_logins` WHERE `user_id` = ?",
        'data': [user_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    return failedList;
};

/**
 * Gets users list of successful logins
 * @param {Number|String} unique_id
 * @return {Promise} User
 * @public
 */
Users.getLoginSessions = async (user_id) => {
    const session_list = await sqlQuery({
        'query': "SELECT * FROM `login_sessions` WHERE `user_id` = ?",
        'data': [user_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    return session_list;
};

/**
 * Gets users last successful login
 * @param {Number|String} user_id
 * @return {Promise} User
 * @public
 */
Users.getLastLoginSession = async (user_id) => {
    const session = await sqlQuery({
        'query': "SELECT * FROM `login_sessions` WHERE `user_id` = ? ORDER BY `create_date` DESC LIMIT 1",
        'data': [user_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    if(session.length == 0)
        return null;
    return session[0];
};

/**
 * Gets users list of failed logins since last successful login
 * @param {Number|String} user_id
 * @return {Promise} User
 * @public
 */
Users.getLoginFailStack = async (user_id) => {
    const failedList = await sqlQuery({
        'query': "SELECT * FROM failed_logins WHERE `user_id` = ? AND `create_date` > COALESCE((SELECT create_date FROM login_sessions WHERE `user_id` = ? ORDER BY `create_date` DESC LIMIT 1), '1970-01-01 00:00:00')",
        'data': [user_id, user_id]
    }).catch(error => {
        return Promise.reject(error);
    });
    return Promise.resolve(failedList);
};

/**
 * Creates a record for a unsuccessful login
 * @param {Number|String} user_id
 * @param {String} ip_address
 * @param {String} user_agent
 * @return {Promise} User
 * @public
 */
Users.createFailedLogin = async (user_id, ip_address = null, user_agent = null) => {
    const failed_login = await sqlQuery({
        'query': "INSERT INTO `failed_logins` (user_id, ip_address, user_agent) VALUES (?, ?, ?)",
        'data': [user_id, ip_address, user_agent]
    }).catch(error => {
        return Promise.reject(error);
    });
    return failed_login;
};

/**
 * Creates a record for a successful login
 * @param {Number|String} user_id
 * @param {String} ip_address
 * @param {String} user_agent
 * @return {Promise} User
 * @public
 */
Users.createLoginSession = async (user_id, ip_address = null, user_agent = null) => {
    const login_session = await sqlQuery({
        'query': "INSERT INTO `login_sessions` (user_id, ip_address, user_agent) VALUES (?, ?, ?)",
        'data': [user_id, ip_address, user_agent]
    }).catch(error => {
        return Promise.reject(error);
    });
    return login_session;
};

module.exports = Users;
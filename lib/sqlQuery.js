const mariadb = require('mariadb');
const { database } = require('../config/app.json');
const pushLog = require('./pushLog');

/**
 * @typedef {Object} QueryObject
 * @property {string} query - SQL query string with placeholders
 * @property {Array<any>} data - Array of values to bind to placeholders
 */

/**
 * @typedef {Object} QueryResult
 * @property {number} [insertId] - ID of inserted row (if applicable)
 * @property {number} [affectedRows] - Number of affected rows
 * @property {Array<Object>} [rows] - Result rows for SELECT queries
 */

/**
 * Connection pools for each configured database
 * @type {Object.<string, mariadb.Pool>}
 */
const pools = {};

/**
 * Initialize connection pools for all MariaDB databases in config
 */
for (const key in database) {
    if (database[key].type === 'MariaDB') {
        pools[key] = mariadb.createPool({
            host: database[key].host,
            port: database[key].port,
            user: database[key].username,
            password: database[key].password,
            database: database[key].database,
            connectionLimit: database[key].connectionLimit || 20,
            acquireTimeout: database[key].acquireTimeout || 10000,
            idleTimeout: database[key].idleTimeout || 600000,
            checkDuplicate: false
        });
        
        pushLog(`Database pool '${key}' initialized`, 'DB Pool Init', 'sql');
    }
}

/**
 * Default database key (first configured database)
 * @type {string}
 */
const DEFAULT_DB = Object.keys(pools)[0];

if (!DEFAULT_DB) {
    throw new Error('No MariaDB databases configured in app.json');
}

/**
 * Substitutes references to previous query results in data array
 * Supports {{index}} for insertId and {{field}}{{index}} for custom fields
 * 
 * @param {Array<any>} data - Data array that may contain result references
 * @param {Array<QueryResult>} previousResults - Results from previous queries
 * @returns {Array<any>} Data array with substituted values
 * @private
 */
function substituteResultReferences(data, previousResults) {
    return data.map(item => {
        if (typeof item !== 'string') {
            return item;
        }
        
        let field = 'insertId';
        
        // Extract field name if specified: {{fieldName}}
        const fieldMatch = item.match(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/);
        if (fieldMatch) {
            field = fieldMatch[1];
            item = item.replace(fieldMatch[0], '');
        }
        
        // Extract and substitute result index: {{number}}
        const indexMatch = item.match(/\{\{(\d+)\}\}/);
        if (indexMatch) {
            const index = parseInt(indexMatch[1], 10);
            
            if (index < 0 || index >= previousResults.length) {
                throw new Error(`Invalid result reference: index ${index} out of bounds`);
            }
            
            const value = previousResults[index][field];
            
            if (value === undefined) {
                throw new Error(`Field '${field}' not found in result ${index}`);
            }
            
            return item.replace(indexMatch[0], value);
        }
        
        return item;
    });
}

/**
 * Executes a single query with proper error context
 * 
 * @param {mariadb.Connection} conn - Database connection
 * @param {string|QueryObject} query - Query to execute
 * @param {string} dbName - Database name for logging
 * @param {Array<QueryResult>} previousResults - Results from previous queries (for substitution)
 * @returns {Promise<QueryResult>} Query result
 * @private
 */
async function executeSingleQuery(conn, query, dbName, previousResults = []) {
    let queryString, queryData;
    
    if (typeof query === 'string') {
        queryString = query;
        queryData = undefined;
    } else if (typeof query === 'object' && query !== null) {
        queryString = query.query;
        queryData = query.data;
        
        if (!queryString) {
            throw new Error('Query object must contain a "query" property');
        }
        
        // Substitute result references if data is provided
        if (queryData && previousResults.length > 0) {
            queryData = substituteResultReferences(queryData, previousResults);
        }
    } else {
        throw new Error('Query must be a string or object with query property');
    }
    
    try {
        const result = await conn.query(queryString, queryData);
        pushLog(`Executed: ${queryString.substring(0, 100)}${queryString.length > 100 ? '...' : ''} on ${dbName}`, 'SQL Query', 'sql');
        return result;
    } catch (err) {
        err.query = queryString;
        err.database = dbName;
        throw err;
    }
}

/**
 * Executes SQL query/queries against specified database
 * 
 * Features:
 * - Single or multiple query execution
 * - Parameter binding for SQL injection prevention
 * - Reference previous query results using {{index}} or {{field}}{{index}}
 * - Automatic connection management
 * - Transaction support for multiple queries
 * 
 * @param {string|QueryObject|Array<string|QueryObject>} query - Query or array of queries to execute
 * @param {string} [dbKey=DEFAULT_DB] - Database key from config (defaults to first configured DB)
 * @param {Object} [options={}] - Execution options
 * @param {boolean} [options.transaction=false] - Wrap multiple queries in a transaction
 * @returns {Promise<QueryResult|Array<QueryResult>>} Query result(s)
 * 
 * @example
 * // Simple query
 * const users = await q('SELECT * FROM users');
 * 
 * @example
 * // Parameterized query (prevents SQL injection)
 * const user = await q({
 *     query: 'SELECT * FROM users WHERE id = ?',
 *     data: [userId]
 * });
 * 
 * @example
 * // Multiple queries with result referencing
 * const results = await q([
 *     { query: 'INSERT INTO users (name) VALUES (?)', data: ['John'] },
 *     { query: 'INSERT INTO profiles (user_id) VALUES (?)', data: ['{{0}}'] }
 * ], 'main', { transaction: true });
 * 
 * @example
 * // Reference specific field from previous result
 * const results = await q([
 *     'SELECT id, email FROM users WHERE name = "admin"',
 *     { query: 'INSERT INTO audit (user_id) VALUES (?)', data: ['{{id}}{{0}}'] }
 * ]);
 */
async function q(query, dbKey = DEFAULT_DB, options = {}) {
    const pool = pools[dbKey];
    
    if (!pool) {
        throw new Error(`Database pool '${dbKey}' not found. Available pools: ${Object.keys(pools).join(', ')}`);
    }
    
    const { transaction = false } = options;
    const isMultiQuery = Array.isArray(query);
    
    // Auto-enable transaction for multiple queries if not explicitly set
    const useTransaction = transaction || (isMultiQuery && query.length > 1);
    
    let conn;
    
    try {
        conn = await pool.getConnection();
        pushLog(`Connection acquired from pool '${dbKey}'`, 'DB Connect', 'sql');
        
        if (useTransaction) {
            await conn.beginTransaction();
            pushLog(`Transaction started on '${dbKey}'`, 'DB Transaction', 'sql');
        }
        
        let results;
        
        if (isMultiQuery) {
            results = [];
            for (let i = 0; i < query.length; i++) {
                const result = await executeSingleQuery(conn, query[i], dbKey, results);
                results.push(result);
            }
        } else {
            results = await executeSingleQuery(conn, query, dbKey);
        }
        
        if (useTransaction) {
            await conn.commit();
            pushLog(`Transaction committed on '${dbKey}'`, 'DB Transaction', 'sql');
        }
        
        return results;
        
    } catch (err) {
        if (useTransaction && conn) {
            try {
                await conn.rollback();
                pushLog(`Transaction rolled back on '${dbKey}' due to error`, 'DB Transaction', 'sql');
            } catch (rollbackErr) {
                pushLog(`Rollback failed on '${dbKey}': ${rollbackErr.message}`, 'DB Error', 'sql');
            }
        }
        
        // Enhance error with context
        err.database = dbKey;
        err.timestamp = new Date().toISOString();
        
        pushLog(`Query error on '${dbKey}': ${err.message}`, 'DB Error', 'sql');
        throw err;
        
    } finally {
        if (conn) {
            conn.release();
            pushLog(`Connection released to pool '${dbKey}'`, 'DB Connect', 'sql');
        }
    }
}

/**
 * Closes all database connection pools
 * Call this when shutting down the application
 * 
 * @returns {Promise<void>}
 * 
 * @example
 * process.on('SIGINT', async () => {
 *     await q.closeAll();
 *     process.exit(0);
 * });
 */
q.closeAll = async function() {
    const closePromises = Object.entries(pools).map(async ([key, pool]) => {
        await pool.end();
        pushLog(`Pool '${key}' closed`, 'DB Pool Close', 'sql');
    });
    
    await Promise.all(closePromises);
};

/**
 * Gets the underlying pool for a specific database
 * Useful for advanced operations or monitoring
 * 
 * @param {string} [dbKey=DEFAULT_DB] - Database key
 * @returns {mariadb.Pool} Connection pool
 * 
 * @example
 * const pool = q.getPool();
 * const poolStats = {
 *     totalConnections: pool.totalConnections(),
 *     activeConnections: pool.activeConnections(),
 *     idleConnections: pool.idleConnections()
 * };
 */
q.getPool = function(dbKey = DEFAULT_DB) {
    const pool = pools[dbKey];
    if (!pool) {
        throw new Error(`Database pool '${dbKey}' not found`);
    }
    return pool;
};

/**
 * Lists all available database pool keys
 * 
 * @returns {Array<string>} Array of database keys
 * 
 * @example
 * const databases = q.getDatabases();
 * console.log('Available databases:', databases);
 */
q.getDatabases = function() {
    return Object.keys(pools);
};

module.exports = q;
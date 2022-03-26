const mariadb = require('mariadb');
const {database} = require('../config/app.json');
const pushLog = require('./pushLog');


const pools = {};
const active_connection = {}; 

for(let key in database){
    if(database[key].type == "MariaDB"){
        pools[key] = mariadb.createPool({
            'host': database[key].host,
            'port': database[key].port,
            'user': database[key].username,
            'password': database[key].password,
            'database': database[key].database,
            'connectionLimit': 20
        });
        active_connection[key] = new Array();
    }
}

const DEFAULT_DB = Object.keys(pools)[0];
const DB_CONN_IDLE_TIMEOUT = process.env.DB_CONN_IDLE_TIMEOUT;


async function q(query, DB = DEFAULT_DB){
    const pool = pools[DB];
    let conn, 
        latest_conn = active_connection[DB][active_connection[DB].length -1] || null,   // GET THE VERY LAST CONNECTION IF EXISTS; IF NOT SET TO null
        results = new Array();
    try {
        // CHECK IF A CONNECTION EXISTS
        if(latest_conn == null){
            // CREATE A NEW CONNECTION
            conn = await pool.getConnection();
            // GENERATE A UNIQUE ID FOR THE CONNECTION
            do{
                conn.id = parseInt(Math.random() * Math.floor(Number.MAX_SAFE_INTEGER));
            }while(active_connection[DB].find(e => e.id == conn.id));
            // SET active_jobs TO 1
            conn.active_jobs = 1;
            // PUSH NEW CONNECTION TO active_connection
            active_connection[DB].push(conn);
            pushLog(`SQL Pool Connection to ${DB} established`, 'DB Connect', 'sql');
        }
        else{
            // SET LATEST CONNECTION AS CURRENT CONNECTION
            conn = latest_conn;
            // INCREASE CURRENT CONNECTION'S active_jobs BY 1
            conn.active_jobs++;
        }
        // IF MULTIPLE QUERY'S IS GIVEN
        if(Array.isArray(query)){
            for(let i = 0; i < query.length; i++){
                // IF ONLY QUERY IS GIVEN; NO DATA PASSED
                if(typeof query[i] == 'string'){
                    results.push(await conn.query(query[i]));
                    pushLog(`${query[i]} to ${DB}`, 'SQL Query', 'sql');
                }
                else {
                    // REPLACE THE UNIQUE_ID FROM PREVIOUS QUERY IF EXISTS {ID: number}{FIELD: string} ORDER DOESN'T MATTER
                    query[i]['data'] = query[i]['data'].map(e => {
                        if(typeof e != 'string')
                            return e;
                        let field = "insertId";
                        e = e.replace(/\{\{([a-z|A-Z]+)\}\}/g, r => {
                            field = r.slice(2, -2);
                            return "";
                        });
                        return e.replace(/\{\{([0-9]+)\}\}/g, r => results[parseInt(r.slice(2, -2))][field]);
                    });
                    results.push(await conn.query(query[i]['query'], query[i]['data']));
                    pushLog(`${query[i]['query']} to ${DB}`, 'SQL Query', 'sql');
                }
            }
        }
        else {
            // IF ONLY QUERY IS GIVEN; NO DATA PASSED
            if(typeof query == 'string'){
                results = await conn.query(query);
                pushLog(`${query} to ${DB}`, 'SQL Query', 'sql');
            }
            else{
                if(typeof query == 'object'){
                    results = await conn.query(query['query'], query['data']);
                    pushLog(`${query['query']} to ${DB}`, 'SQL Query', 'sql');
                }
            }
        }
    } catch (err) {
        throw err;
    } finally {
        conn.active_jobs--;    // JOB DONE THEREFORE DECREASE active_jobs BY ONE;
        if (conn['checkConnection'] == undefined){
            conn['checkConnection'] = setInterval(()=>{
                if(conn.active_jobs <= 0){
                    clearInterval(conn['checkConnection']);
                    conn.release(); //release to connection
                    active_connection[DB] = active_connection[DB].filter((e, i) => e.id != conn.id);
                    pushLog(`SQL Pool Connection to ${DB} released`, 'DB Connect', 'sql');
                }
            }, DB_CONN_IDLE_TIMEOUT);
        }
    }
    return results;
}

module.exports = q;
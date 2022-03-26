const {createConnection} = require('mongoose');
const {database} = require('../config/app.json');
const pushLog = require('./pushLog');

const mongodb = {};

for(let key in database){
    if(database[key].type == "MongoDB"){
        mongodb[key] = {
            'host': database[key].host,
            'port': database[key].port,
            'authSource': database[key].authSource,
            'user': database[key].username,
            'password': database[key].password,
            'name': database[key].name,
        };
    }
}

const DEFAULT_DB = Object.keys(mongodb)[0];

function db(DB = DEFAULT_DB){
    const db = mongodb[DB];
    const dbUri = `mongodb://${db.user}:${db.password}@${db.host}:${db.port}/${db.name}?authSource=${db.authSource}`;
    // Use connect method to connect to the server
    return createConnection(dbUri, {useNewUrlParser: true, useUnifiedTopology: true});
}

module.exports = db;
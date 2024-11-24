const http_request = require('http').request;
const https_request = require('https').request;
const {OAuth, OAuth2} = require('oauth');
const querystring = require('querystring');
const url = require('url');
const {services} = require("../config/app.json");
const pushLog = require("./pushLog");

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 6000;
const MAX_REDIRECT = 3;

// INIT OAuth DICT
let OAuth_sessions = {};
for(let key in services){
    if(services[key].authorization.type == "OAuth2")
        OAuth_sessions[key] = {
            'access_token:': null,
            'token_type': null,
            'exprire': null,
            'refresh_token': null
        };
}

class RestApi {
    /**
     * Prepare a Request to an endpoint
     * @param {string} serviceName
     * @param {string} endpointName
     * @param {Object} options
     * @param {Object} options.params
     * @param {Object} options.queries
     * @param {Object} options.headers
     * @return 
    */
    constructor(serviceName, endpointName, options = {'params': {}, 'queries': {}, 'headers': {}}){
        // VALIDATE INPUT & SET
        if(this.validateInputs(serviceName, endpointName, options) != true){
            pushLog(`RestApi Validation of ${serviceName}: ${endpointName} failed`, 'RestApi');
            return;
        }
        // LOAD REST SERVICE
        const service = services[this.serviceName];
        const endpoint = service.endpoints[this.endpointName];

        this.redirects = 0;
        this.hostname = service.hostname;
        this.path = service.path + this.endpointPath;
        this.port = service.port;
        this.secure = service.secure;
        this.method = endpoint.method;
        this.queries = {...service.queries, ...endpoint.queries, ...this.queries};
        this.headers = {...service.headers, ...endpoint.headers, ...this.headers};
        this.options = {
            'method': this.method,
            'hostname': this.hostname,
            'path': this.path + '?' + querystring.stringify(this.queries),
            'port': this.port,
            'headers': this.headers,
            'timeout': REQUEST_TIMEOUT
        };
        this.authorized = this.authorize(service.authorization);
        this.authorized.then((auth_header)=> {
            this.options.headers = {...this.options.headers, ...auth_header};
        }, (error)=>{
            console.error(error);
            pushLog(`RestApi authorization of ${serviceName}: ${endpointName} failed. Authorization type was ${service.authorization.type}`, 'RestApi');
        });
    }

    /**
     * Validates the given data with the requirements of the endpoint
     * @param {String} serviceName 
     * @param {String} endpointName 
     * @param {Object} options
     * @param {Object} options.params
     * @param {Object} options.queries
     * @param {Object} options.headers
     * @returns {Boolean}
     */
    validateInputs(serviceName, endpointName, options){
        // VALIDATE serviceName
        if(typeof serviceName !== 'string')
            throw `First parameter must be typeof string, ${typeof serviceName} given`;
        else {
            if(services.hasOwnProperty(serviceName) == false)
                throw `${serviceName} is not a defined service connection`;
            this.serviceName = serviceName;
        }
        // VALIDATE endpointName
        if(typeof endpointName !== 'string')
            throw `Second parameter must be typeof string, ${typeof endpointName} given`;
        else {
            if(services[serviceName].endpoints.hasOwnProperty(endpointName)  == false)
                throw `${endpointName} is not a defined endpoint`;
            this.endpointName = endpointName;
        }
        // VALIDATE options
        if(typeof options !== 'object')
            throw `Thrid parameter must be typeof object, ${typeof options} given`;
        else {
            // VALIDATE options.params
            if(options.hasOwnProperty('params') && typeof options.params !== 'object')
                throw `options.params parameter must be typeof object, ${typeof options.queries} given`;
            this.params = options.params || {};
            
            // CHECK IF REQUIRED PARAMS MATCHES WITH THE SET OF GIVEN ONES
            let error = false;
            this.endpointPath = services[serviceName].endpoints[endpointName].path.replace(/\{\{([a-z|A-Z]+)\}\}/g, e => {
                const replace = e.slice(2, -2);
                const replacement = this.params[replace];
                if(typeof replacement == 'string' || typeof replacement == 'number')
                    return replacement;
                throw `The required field ${e} is not given in options.params. Checkout app.json -> services -> ${serviceName} -> endpoints -> ${endpointName} -> path`;
            });

            // VALIDATE options.queries
            if(options.hasOwnProperty('queries') && typeof options.queries !== 'object')
                throw `options.queries parameter must be typeof object, ${typeof options.queries} given`;
            this.queries = options.queries || {};
            // VALIDATE options.headers
            if(options.hasOwnProperty('headers') && typeof options.headers !== 'object')
                throw `options.headers parameter must be typeof object, ${typeof options.headers} given`;
            this.headers = options.headers || {};
        }
        // VALIDATION COMPLETED
        pushLog(`RestApi Validation of ${serviceName}: ${endpointName} completed`, 'RestApi');
        return true;
    }

    /**
     * 
     * @param {Object} auth
     * @param {() => {}} auth
     * @returns {Promise}
     */
    async authorize(auth){
        switch(auth.type){
            case null:
                break;
            case "Basic":
                if(typeof auth.username != 'string' || typeof auth.password != 'string')
                    throw "Basic authorization requires username and password. Please check your app.json file...";
                this.headers[auth['auth-header'] || 'Authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf-8').toString('base64')}`;
                break;
            case "OAuth2":
                // CHECK IF ACCESS ALREADY IS GRANTED
                let existing_oauth = OAuth_sessions[this.serviceName];
                if(existing_oauth['access_token'] != null){
                    if(existing_oauth['access_token']['expire'] > (new Date()).getTime()){
                        this.headers[auth['auth-header'] || 'Authorization'] = `${existing_oauth.token_type} ${existing_oauth.access_token}`;
                        return;
                    }
                }
                const oauth2 = new OAuth2(auth.client_id, auth.client_secret, auth.hostname, auth.auth_path, auth.token_path, null);
                await (new Promise((resolve, reject)=>{
                    oauth2.getOAuthAccessToken('', auth.params, (error, access_token, refresh_token, results) =>{
                        if(error == null){
                            existing_oauth.token_type = results.token_type;
                            existing_oauth.access_token = access_token;
                            existing_oauth.refresh_token = refresh_token || null;
                            existing_oauth.exprire = (new Date()).getTime() + ((results.expires_in || 0) * 1000);
                            this.headers[auth['auth-header'] || 'Authorization'] = `${existing_oauth.token_type} ${existing_oauth.access_token}`;
                            resolve();
                        }
                        else {
                            pushLog(error, `OAuth2(${this.serviceName}:${this.endpointName})`);
                            reject(error);
                        }
                    });
                }));
                break;
            case "x-auth":
                if(typeof auth.token != 'string')
                    throw "Basic x-authorization requires token. Please check your app.json file...";
                this.headers[auth['auth-header'] || 'Authorization'] = auth.token;
                break;
            default:
                throw `Given authorization type: ${auth.type}, is not supported.`;
        }
        return true;
    }

    /**
     * 
     * @param {{}} body
     * @param {Boolean} follow
     * @returns {Promise}
     */
    async req(body = null, follow = false){
        // WAIT UNTIL AUTHORIZATION PROCESS FINISHED
        if(await this.authorized != true){
            throw new Error("Authorization failed");
        }
        // SEND BODY IF METHOD IS NOT GET OR BODY ISN'T NULL
        if(this.method != "GET" && body != null){
            // SET CONTENT LENGTH
            body = typeof body === 'string' ? body : JSON.stringify(body);
            this.options.headers = Object.assign(this.options.headers, {
                'Content-Length': Buffer.byteLength(body)
            });
        }
        return new Promise((resolve, reject)=>{
            const request = this.secure ? https_request : http_request;
            this.api_request = request(this.options, async res => {
                switch(res.statusCode){
                    case 200:   // IF REQUEST WAS SUCCESSFUL
                    case 201:   // IF REQUEST WAS SUCCESSFUL
                        break;
                    case 302:   // IF SERVER RESPONSES WITH A REDIRECT 
                    case 303:   // IF SERVER RESPONSES WITH A REDIRECT 
                    case 307:
                        // IF follow IS NOT true SET REJECT AND QUIT
                        if(follow == false){ 
                            reject(`Server responsed with code ${res.statusCode} to redirect but will not follow`);
                            return;
                        }
                        // IF follow IS NOT true SET REJECT AND QUIT
                        if(this.redirects >= MAX_REDIRECT){ 
                            reject(`Server responsed with code ${res.statusCode} to redirect but reached max redirects of ${MAX_REDIRECT}`);
                            return;
                        }
                        else
                            this.redirects++;
                        // IF REDIRECT -> FOLLOW
                        if(res.headers.location == undefined){
                            reject(`Server responsed with code ${res.statusCode} but is not providing location uri`);
                            return;
                        }
                        // CHECK IF REDIRECT STRING CONTAINS PORT
                        let location = url.parse(res.headers.location);
                        this.options.hostname = location.hostname;
                        this.options.port = location.port
                        this.options.path = location.path;
                        this.options.headers['Cookies'] = res.headers["set-cookie"].map(e => e.split(';', 1)).join('; ');
                        await this.req(null, true).then((body)=> {
                            resolve(body);
                        }, (error) => {
                            reject(error);
                        });
                        return;
                    default:
                        reject({'status_code': res.statusCode});
                        return;
                }
                // REQUEST CALL SUCCESSFUL
                let body = [];
                res.on('data', (data)=> {
                    if(typeof data == 'string' || Buffer.isBuffer(data))
                        body.push(data);
                    else {
                        pushLog(data, "Chunk is not String or Buffer", 'request');
                    }
                });
                res.on('end', ()=> {
                    body = Buffer.concat(body).toString('utf8');
                    try{
                        body = JSON.parse(body);
                    }catch(e){
                        resolve(body);
                    }
                    resolve(body);
                    this.response = body;
                });
            });
            if(this.method != "GET" && body != null)
                this.api_request.write(body);
            // ON ERROR
            this.api_request.on('error', error => {
                console.error(error);
                reject(error);
            });
            // SEND REQUEST
            this.api_request.end();
        });
    }
}

module.exports = RestApi;
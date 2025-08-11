const fetch = require("node-fetch");
const {services} = require("../config/app.json");
const cache = require("./OAuthCache");
const pushLog = require("./pushLog");

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 10000;
const MAX_REDIRECTS = parseInt(process.env.MAX_REDIRECTS) || 5;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 2;

class RestApiError extends Error {
    constructor(message, status, response, url) {
        super(message);
        this.name = 'RestApiError';
        this.status = status;
        this.response = response;
        this.url = url;
    }
}

class RestApi {
    constructor(config) {
        this.serviceName = config.serviceName;
        this.endpointName = config.endpointName;
        this.method = config.method.toUpperCase();
        this.url = config.url;
        this.headers = {
            ...config.headers
        };
        this.timeout = config.timeout || REQUEST_TIMEOUT;
        this.retries = 0;
    }

    static async create(serviceName, endpointName, options = {}) {
        const config = await RestApi.buildConfig(serviceName, endpointName, options);
        return new RestApi(config);
    }

    static resolvePath(template, params = {}) {
        return template.replace(/\{\{(.+?)\}\}/g, (match, key) => {
            const trimmedKey = key.trim();
            if (!(trimmedKey in params)) {
                throw new Error(`Missing required parameter: ${trimmedKey}`);
            }
            return encodeURIComponent(params[trimmedKey]);
        });
    }

    static serializeQueryParams(obj, prefix = '') {
        const params = new URLSearchParams();
        
        function serialize(value, key) {
            if (value === null || value === undefined) {
                return;
            }
            
            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    const arrayKey = `${key}[${index}]`;
                    serialize(item, arrayKey);
                });
            } else if (typeof value === 'object' && value !== null) {
                Object.keys(value).forEach(subKey => {
                    const objectKey = key ? `${key}[${subKey}]` : subKey;
                    serialize(value[subKey], objectKey);
                });
            } else {
                params.append(key, String(value));
            }
        }
        
        Object.keys(obj).forEach(key => {
            const fullKey = prefix ? `${prefix}[${key}]` : key;
            serialize(obj[key], fullKey);
        });
        
        return params;
    }

    static buildUrl(service, path, queries = {}) {
        const protocol = service.secure !== false ? "https" : "http";
        const port = service.port ? `:${service.port}` : "";
        const basePath = service.path || "";

        const url = new URL(`${protocol}://${service.hostname}${port}${basePath}${path}`);

        // Merge query parameters
        const allQueries = {
            ...(service.queries || {}),
            ...queries
        };

        // Use the enhanced serialization for complex objects/arrays
        if (Object.keys(allQueries).length > 0) {
            const serializedParams = RestApi.serializeQueryParams(allQueries);
            
            // Append all serialized parameters to the URL
            for (const [key, value] of serializedParams.entries()) {
                url.searchParams.append(key, value);
            }
        }

        return url.toString();
    }

    static async buildConfig(serviceName, endpointName, options = {}) {
        const service = services[serviceName];
        if (!service) {
            throw new Error(`Service '${serviceName}' not found in configuration`);
        }

        const endpoint = service.endpoints?.[endpointName];
        if (!endpoint) {
            throw new Error(`Endpoint '${endpointName}' not found for service '${serviceName}'`);
        }

        // Resolve path parameters
        const resolvedPath = RestApi.resolvePath(endpoint.path, options.params);

        // Build complete URL
        const queries = {
            ...(endpoint.queries || {}),
            ...(options.queries || {})
        };
        const url = RestApi.buildUrl(service, resolvedPath, queries);

        // Merge headers with precedence: options > endpoint > service
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': `RestApi/1.0 (${serviceName})`,
            ...(service.headers || {}),
            ...(endpoint.headers || {}),
            ...(options.headers || {})
        };

        // Apply authorization
        if (service.authorization) {
            await RestApi.applyAuthorization(headers, serviceName, service.authorization);
        }

        return {
            serviceName,
            endpointName,
            method: endpoint.method || 'GET',
            url,
            headers,
            timeout: options.timeout
        };
    }

    static async applyAuthorization(headers, serviceName, auth) {
        if (!auth?.type) return;

        const authHeader = auth["auth-header"] || "Authorization";

        try {
            switch (auth.type.toLowerCase()) {
                case "basic": {
                    const {
                        username,
                        password
                    } = auth;
                    if (!username || !password) {
                        throw new Error("Basic auth requires username and password");
                    }
                    const credentials = Buffer.from(`${username}:${password}`).toString("base64");
                    headers[authHeader] = `Basic ${credentials}`;
                    break;
                }

                case "bearer":
                case "x-auth": {
                    if (!auth.token) {
                        throw new Error(`${auth.type} requires a token`);
                    }
                    headers[authHeader] = auth.type.toLowerCase() === "bearer" ?
                        `Bearer ${auth.token}` :
                        auth.token;
                    break;
                }

                case "oauth2": {
                    const token = await RestApi.getOAuthToken(serviceName, auth);
                    headers[authHeader] = `${token.token_type || 'Bearer'} ${token.access_token}`;
                    break;
                }

                case "api-key": {
                    if (!auth.key) {
                        throw new Error("API key auth requires a key");
                    }
                    headers[auth["key-header"] || "X-API-Key"] = auth.key;
                    break;
                }

                default:
                    throw new Error(`Unsupported authorization type: ${auth.type}`);
            }
        } catch (error) {
            throw new Error(`Authorization failed for ${serviceName}: ${error.message}`);
        }
    }

    static async getOAuthToken(serviceName, auth) {
        // Check cache first
        const cached = await cache.get(serviceName);
        if (cached && cached.expires > Date.now() + 60000) { // 1 minute buffer
            return cached;
        }

        // Request new token
        const tokenUrl = `${auth.secure !== false ? 'https' : 'http'}://${auth.hostname}${auth.token_path}`;

        const body = new URLSearchParams({
            grant_type: auth.grant_type || "client_credentials",
            client_id: auth.client_id,
            client_secret: auth.client_secret,
            ...(auth.scope && {
                scope: auth.scope
            }),
            ...(auth.params || {})
        });

        const response = await fetch(tokenUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json"
            },
            body,
            timeout: 10000
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OAuth2 token request failed (${response.status}): ${errorText}`);
        }

        const tokenData = await response.json();

        if (!tokenData.access_token) {
            throw new Error("Invalid OAuth2 response: missing access_token");
        }

        // Cache token with 10% buffer before expiration
        const expiresIn = tokenData.expires_in || 3600;
        const expires = Date.now() + (expiresIn * 900); // 90% of actual expiry

        const token = {
            access_token: tokenData.access_token,
            token_type: tokenData.token_type || 'Bearer',
            expires,
            refresh_token: tokenData.refresh_token
        };

        await cache.set(serviceName, token, Math.floor(expiresIn * 0.9));
        return token;
    }

    async request(body = null, options = {}) {
        const requestOptions = {
            method: this.method,
            headers: {
                ...this.headers
            },
            timeout: options.timeout || this.timeout,
            signal: options.signal
        };

        // Handle request body
        if (body !== null && !['GET', 'HEAD'].includes(this.method)) {
            if (typeof body === 'object' && this.headers['Content-Type']?.includes('application/json')) {
                requestOptions.body = JSON.stringify(body);
            } else if (typeof body === 'string') {
                requestOptions.body = body;
            } else {
                requestOptions.body = body;
            }
        }

        let lastError;

        // Retry logic
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await this.executeRequest(requestOptions);
                return await this.handleResponse(response);
            } catch (error) {
                lastError = error;

                // Don't retry client errors (4xx) or non-network errors
                if (error.status >= 400 && error.status < 500) {
                    break;
                }

                if (attempt < MAX_RETRIES) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    async executeRequest(options) {
        let response = await fetch(this.url, options);
        let redirectCount = 0;

        // Handle redirects manually for better control
        while (this.isRedirect(response.status) && redirectCount < MAX_REDIRECTS) {
            const location = response.headers.get("location");
            if (!location) {
                throw new RestApiError("Redirect response missing Location header", response.status, null, this.url);
            }

            // Handle relative URLs
            this.url = new URL(location, this.url).toString();
            redirectCount++;

            // For 303, change method to GET
            if (response.status === 303) {
                options.method = 'GET';
                delete options.body;
            }

            response = await fetch(this.url, options);
        }

        if (redirectCount >= MAX_REDIRECTS) {
            throw new RestApiError("Too many redirects", 310, null, this.url);
        }

        return response;
    }

    isRedirect(status) {
        return [301, 302, 303, 307, 308].includes(status);
    }

    async handleResponse(response) {
        const contentType = response.headers.get("content-type") || "";
        let responseBody;

        try {
            if (contentType.includes("application/json")) {
                responseBody = await response.json();
            } else if (contentType.includes("text/")) {
                responseBody = await response.text();
            } else {
                responseBody = await response.buffer();
            }
        } catch (parseError) {
            if(response.size > 0){
                responseBody = await response.text(); // Fallback to text
            }
            else {
                responseBody = response.statusText;
            }
        }

        if (!response.ok) {
            // Log error details
            pushLog({
                error: true,
                service: this.serviceName,
                endpoint: this.endpointName,
                method: this.method,
                url: this.url,
                status: response.status,
                response: responseBody
            }, `RestApi Error`);

            throw new RestApiError(
                `HTTP ${response.status}: ${this.getErrorMessage(responseBody)}`,
                response.status,
                responseBody,
                this.url
            );
        }

        return responseBody;
    }

    getErrorMessage(responseBody) {
        if (typeof responseBody === 'object') {
            return responseBody.message || responseBody.error || JSON.stringify(responseBody);
        }
        return responseBody || 'Unknown error';
    }

    // Convenience methods
    async get(queries = {}, options = {}) {
    if (Object.keys(queries).length > 0) {
        const url = new URL(this.url);
        const serializedParams = RestApi.serializeQueryParams(queries);
        
        // Append all serialized parameters to the URL
        for (const [key, value] of serializedParams.entries()) {
            url.searchParams.append(key, value);
        }
        
        this.url = url.toString();
    }
    return this.request(null, options);
}

    async post(body, options = {}) {
        this.method = 'POST';
        return this.request(body, options);
    }

    async put(body, options = {}) {
        this.method = 'PUT';
        return this.request(body, options);
    }

    async patch(body, options = {}) {
        this.method = 'PATCH';
        return this.request(body, options);
    }

    async delete(options = {}) {
        this.method = 'DELETE';
        return this.request(null, options);
    }
}

module.exports = {
    RestApi,
    RestApiError
};
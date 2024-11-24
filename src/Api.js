class Api {
    /**
     * @param {Object[]} data 
     * @param {{take: number, skip: number}} meta
     * @returns {{data: Object[], meta: {count: number, limit: number, offset: number}}}
     */
    static getAllResponseBody = (data, meta) => {
        return {
            'data': data,
            'meta': {
                'count': data.length,
                'limit': meta.take,
                'offset': meta.skip
            },
        };
    }

    /**
     * @param {number} status_code 
     * @param {number} code 
     * @param {string} error_message 
     * @returns {{'status_code': number, 'error': number, 'message': string}}
     */
    static errorResponseBody = (status_code, code, error_message) => {
        return {
            'status_code': status_code, 
            'error_code': code,
            'message': error_message
        };
    };
}

class ErrorResponse extends Error {
    /**
     * @param {string} message 
     * @param {number} status_code 
     */
    constructor(message, status_code = 500){
        super(message);
        this.status_code = status_code;
    }
}

module.exports = {Api, ErrorResponse};
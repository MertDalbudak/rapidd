import { LanguageDict } from './i18n';

/**
 * Basic error response with HTTP status code
 */
export class ErrorBasicResponse extends Error {
    status_code: number;

    constructor(message: string, status_code: number = 500) {
        super(message);
        this.status_code = status_code;
    }

    toJSON(): { status_code: number; message: string } {
        return {
            status_code: this.status_code,
            message: this.message,
        };
    }
}

/**
 * Localized error response with i18n support via LanguageDict.
 * Constructor takes (status_code, message_key, data?) — NOT the standard Error(message) order.
 */
export class ErrorResponse extends ErrorBasicResponse {
    data: Record<string, unknown> | null;

    constructor(status_code: number, message: string, data: Record<string, unknown> | null = null) {
        super(message, status_code);
        this.data = data;
    }

    toJSON(language: string = 'en_US'): { status_code: number; message: string } {
        return {
            status_code: this.status_code,
            message: LanguageDict.get(this.message, this.data, language),
        };
    }

    static badRequest(key: string, data: Record<string, unknown> | null = null): ErrorResponse {
        return new ErrorResponse(400, key, data);
    }

    static unauthorized(key: string, data: Record<string, unknown> | null = null): ErrorResponse {
        return new ErrorResponse(401, key, data);
    }

    static forbidden(key: string, data: Record<string, unknown> | null = null): ErrorResponse {
        return new ErrorResponse(403, key, data);
    }

    static notFound(key: string, data: Record<string, unknown> | null = null): ErrorResponse {
        return new ErrorResponse(404, key, data);
    }

    static conflict(key: string, data: Record<string, unknown> | null = null): ErrorResponse {
        return new ErrorResponse(409, key, data);
    }

    static tooManyRequests(key: string, data: Record<string, unknown> | null = null): ErrorResponse {
        return new ErrorResponse(429, key, data);
    }
}

/**
 * Success response with i18n support
 */
export class Response {
    status_code: number;
    message: string;
    data: Record<string, unknown> | null;

    constructor(status_code: number, message: string, data: Record<string, unknown> | null = null) {
        this.status_code = status_code;
        this.message = message;
        this.data = data;
    }

    toJSON(language: string = 'en_US'): { status_code: number; message: string; data: Record<string, unknown> | null } {
        return {
            status_code: this.status_code,
            message: LanguageDict.get(this.message, this.data, language),
            data: this.data,
        };
    }
}

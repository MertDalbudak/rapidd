import { LanguageDict } from './language';

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

    toJSON(language: string = 'en-US'): { status_code: number; message: string } {
        return {
            status_code: this.status_code,
            message: LanguageDict.get(this.message, this.data, language),
        };
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

    toJSON(language: string = 'en-US'): { status_code: number; message: string; data: Record<string, unknown> | null } {
        return {
            status_code: this.status_code,
            message: LanguageDict.get(this.message, this.data, language),
            data: this.data,
        };
    }
}

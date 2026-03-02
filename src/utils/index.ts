export { ApiClient, ApiClientError } from './ApiClient';
export type { ServiceConfig, EndpointConfig, AuthConfig, RequestOptions, ApiResponse } from './ApiClient';

export { Mailer } from './Mailer';
export type { EmailConfig, EmailOptions, EmailAttachment, EmailResult } from './Mailer';

export const env = {
    isProduction: () => process.env.NODE_ENV === 'production',
    isDevelopment: () => __filename.endsWith('.ts') || process.env.NODE_ENV === 'development',
    isTest: () => process.env.NODE_ENV === 'test',
    current: () => process.env.NODE_ENV || 'development',

    get: <T extends string | number | boolean>(key: string, defaultValue: T): T => {
        const value = process.env[key];
        if (value === undefined) return defaultValue;

        if (typeof defaultValue === 'number') {
            return parseInt(value, 10) as T;
        }
        if (typeof defaultValue === 'boolean') {
            return (value.toLowerCase() === 'true') as T;
        }
        return value as T;
    }
};

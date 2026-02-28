import { ErrorBasicResponse, ErrorResponse, Response } from '../../src/core/errors';

// Mock LanguageDict
jest.mock('../../src/core/i18n', () => ({
    LanguageDict: {
        get: jest.fn((key: string, data: any, _language: string) => {
            if (key === 'not_found') return 'Resource not found';
            if (key === 'hello_user' && data?.name) return `Hello ${data.name}`;
            return key;
        }),
    },
}));

describe('ErrorBasicResponse', () => {
    it('should create error with default status 500', () => {
        const err = new ErrorBasicResponse('test error');
        expect(err.message).toBe('test error');
        expect(err.status_code).toBe(500);
        expect(err).toBeInstanceOf(Error);
    });

    it('should create error with custom status code', () => {
        const err = new ErrorBasicResponse('not found', 404);
        expect(err.status_code).toBe(404);
        expect(err.message).toBe('not found');
    });

    it('should serialize to JSON', () => {
        const err = new ErrorBasicResponse('bad request', 400);
        expect(err.toJSON()).toEqual({
            status_code: 400,
            message: 'bad request',
        });
    });
});

describe('ErrorResponse', () => {
    it('should create localized error', () => {
        const err = new ErrorResponse(404, 'not_found');
        expect(err.status_code).toBe(404);
        expect(err.message).toBe('not_found');
        expect(err.data).toBeNull();
    });

    it('should create error with additional data', () => {
        const err = new ErrorResponse(400, 'validation_failed', { field: 'email' });
        expect(err.data).toEqual({ field: 'email' });
    });

    it('should serialize with i18n translation', () => {
        const err = new ErrorResponse(404, 'not_found');
        const json = err.toJSON('en-US');
        expect(json.status_code).toBe(404);
        expect(json.message).toBe('Resource not found');
    });

    it('should serialize with data interpolation', () => {
        const err = new ErrorResponse(200, 'hello_user', { name: 'Alice' });
        const json = err.toJSON('en-US');
        expect(json.message).toBe('Hello Alice');
    });

    it('should be instanceof ErrorBasicResponse and Error', () => {
        const err = new ErrorResponse(500, 'server_error');
        expect(err).toBeInstanceOf(ErrorBasicResponse);
        expect(err).toBeInstanceOf(Error);
    });
});

describe('Response', () => {
    it('should create a success response', () => {
        const res = new Response(200, 'success');
        expect(res.status_code).toBe(200);
        expect(res.message).toBe('success');
        expect(res.data).toBeNull();
    });

    it('should create a response with data', () => {
        const res = new Response(201, 'created', { id: '123' });
        expect(res.data).toEqual({ id: '123' });
    });

    it('should serialize to JSON with i18n', () => {
        const res = new Response(200, 'hello_user', { name: 'Bob' });
        const json = res.toJSON('en-US');
        expect(json.status_code).toBe(200);
        expect(json.message).toBe('Hello Bob');
        expect(json.data).toEqual({ name: 'Bob' });
    });
});

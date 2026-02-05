import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { randomUUID } from 'crypto';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UploadOptions {
    maxFileSize?: number;
    maxFiles?: number;
    allowedTypes?: 'images' | 'documents' | 'media' | 'all' | AllowedType[];
    tempDir?: string;
    preserveExtension?: boolean;
}

export interface AllowedType {
    mime: string;
    extensions: string[];
}

export interface UploadedFile {
    fieldname: string;
    filename: string;
    originalName: string;
    mimetype: string;
    size: number;
    tempPath: string;
    extension: string;
    saveTo: (destination: string) => Promise<string>;
}

// ── Type Presets ─────────────────────────────────────────────────────────────

const TYPE_PRESETS: Record<string, AllowedType[]> = {
    images: [
        { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
        { mime: 'image/png', extensions: ['.png'] },
        { mime: 'image/gif', extensions: ['.gif'] },
        { mime: 'image/webp', extensions: ['.webp'] },
        { mime: 'image/svg+xml', extensions: ['.svg'] }
    ],
    documents: [
        { mime: 'application/pdf', extensions: ['.pdf'] },
        { mime: 'text/plain', extensions: ['.txt'] },
        { mime: 'application/msword', extensions: ['.doc'] },
        { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extensions: ['.docx'] },
        { mime: 'application/vnd.ms-excel', extensions: ['.xls'] },
        { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extensions: ['.xlsx'] },
        { mime: 'text/csv', extensions: ['.csv'] }
    ],
    media: [
        { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
        { mime: 'image/png', extensions: ['.png'] },
        { mime: 'image/gif', extensions: ['.gif'] },
        { mime: 'image/webp', extensions: ['.webp'] },
        { mime: 'video/mp4', extensions: ['.mp4'] },
        { mime: 'video/webm', extensions: ['.webm'] },
        { mime: 'audio/mpeg', extensions: ['.mp3'] },
        { mime: 'audio/wav', extensions: ['.wav'] }
    ],
    all: []
};

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 10;
const DEFAULT_TEMP_DIR = path.join(process.cwd(), 'temp', 'uploads');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAllowedTypes(option: UploadOptions['allowedTypes']): AllowedType[] {
    if (!option || option === 'all') {
        return [];
    }
    if (Array.isArray(option)) {
        return option;
    }
    return TYPE_PRESETS[option] || [];
}

function validateFile(
    file: { mimetype: string; filename: string },
    allowedTypes: AllowedType[]
): { valid: boolean; error?: string } {
    if (file.filename.includes('..') || file.filename.includes('/') || file.filename.includes('\\')) {
        return { valid: false, error: 'Invalid filename' };
    }

    if (allowedTypes.length === 0) {
        return { valid: true };
    }

    const ext = path.extname(file.filename).toLowerCase();
    const allowedType = allowedTypes.find(t => t.mime === file.mimetype);

    if (!allowedType) {
        return { valid: false, error: `File type '${file.mimetype}' not allowed` };
    }

    if (!allowedType.extensions.includes(ext)) {
        return { valid: false, error: `Extension '${ext}' does not match MIME type '${file.mimetype}'` };
    }

    return { valid: true };
}

function createSizeTracker(maxSize: number): { tracker: Transform; getSize: () => number } {
    let size = 0;
    const tracker = new Transform({
        transform(chunk, encoding, callback) {
            size += chunk.length;
            if (size > maxSize) {
                callback(new Error(`File size exceeds limit of ${Math.round(maxSize / 1024 / 1024)}MB`));
                return;
            }
            callback(null, chunk);
        }
    });
    return { tracker, getSize: () => size };
}

async function saveToTemp(
    stream: NodeJS.ReadableStream,
    tempDir: string,
    filename: string,
    maxSize: number
): Promise<{ tempPath: string; size: number }> {
    if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = path.join(tempDir, `${randomUUID()}-${filename}`);
    const writeStream = createWriteStream(tempPath);
    const { tracker, getSize } = createSizeTracker(maxSize);

    await pipeline(stream, tracker, writeStream);

    return { tempPath, size: getSize() };
}

function createSaveToFn(tempPath: string, ext: string, preserveExtension: boolean) {
    return async (destination: string): Promise<string> => {
        const destDir = path.isAbsolute(destination)
            ? destination
            : path.join(process.cwd(), destination);

        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
        }

        const finalName = preserveExtension ? `${randomUUID()}${ext}` : randomUUID();
        const finalPath = path.join(destDir, finalName);

        const fs = await import('fs/promises');
        await fs.rename(tempPath, finalPath);

        return finalPath;
    };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * Fastify multipart upload plugin with security validation.
 *
 * @example
 * // Register plugin
 * app.register(uploadPlugin, {
 *     maxFileSize: 5 * 1024 * 1024, // 5MB
 *     allowedTypes: 'images',
 *     tempDir: '/tmp/uploads'
 * });
 *
 * @example
 * // In route - single file
 * fastify.post('/upload', async (request, reply) => {
 *     const file = await request.uploadFile();
 *     if (!file) {
 *         return reply.sendError(400, 'no_file_uploaded');
 *     }
 *     const savedPath = await file.saveTo('./uploads');
 *     return { path: savedPath };
 * });
 *
 * @example
 * // In route - multiple files
 * fastify.post('/upload-many', async (request, reply) => {
 *     const files = await request.uploadFiles();
 *     const paths = await Promise.all(
 *         files.map(f => f.saveTo('./uploads'))
 *     );
 *     return { paths };
 * });
 */
async function uploadPluginImpl(
    fastify: FastifyInstance,
    options: UploadOptions
): Promise<void> {
    const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const allowedTypes = getAllowedTypes(options.allowedTypes);
    const tempDir = options.tempDir ?? DEFAULT_TEMP_DIR;
    const preserveExtension = options.preserveExtension ?? true;

    // Register @fastify/multipart
    await fastify.register(import('@fastify/multipart'), {
        limits: {
            fileSize: maxFileSize,
            files: maxFiles
        }
    });

    // Add upload methods via hook (avoids decorateRequest typing issues)
    fastify.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        const contentType = request.headers['content-type'] || '';

        // Always attach the methods, they'll handle non-multipart gracefully
        (request as any).uploadFile = async (): Promise<UploadedFile | null> => {
            if (!contentType.includes('multipart/form-data')) {
                return null;
            }

            const data = await (request as any).file();
            if (!data) return null;

            const validation = validateFile(data, allowedTypes);
            if (!validation.valid) {
                throw new Error(validation.error);
            }

            const { tempPath, size } = await saveToTemp(data.file, tempDir, data.filename, maxFileSize);
            const ext = path.extname(data.filename);

            return {
                fieldname: data.fieldname,
                filename: path.basename(tempPath),
                originalName: data.filename,
                mimetype: data.mimetype,
                size,
                tempPath,
                extension: ext,
                saveTo: createSaveToFn(tempPath, ext, preserveExtension)
            };
        };

        (request as any).uploadFiles = async (): Promise<UploadedFile[]> => {
            if (!contentType.includes('multipart/form-data')) {
                return [];
            }

            const files: UploadedFile[] = [];
            const parts = (request as any).files();

            for await (const part of parts) {
                if (part.type !== 'file') continue;

                const validation = validateFile(part, allowedTypes);
                if (!validation.valid) {
                    throw new Error(validation.error);
                }

                const { tempPath, size } = await saveToTemp(part.file, tempDir, part.filename, maxFileSize);
                const ext = path.extname(part.filename);

                files.push({
                    fieldname: part.fieldname,
                    filename: path.basename(tempPath),
                    originalName: part.filename,
                    mimetype: part.mimetype,
                    size,
                    tempPath,
                    extension: ext,
                    saveTo: createSaveToFn(tempPath, ext, preserveExtension)
                });
            }

            return files;
        };
    });
}

// Extend FastifyRequest type
declare module 'fastify' {
    interface FastifyRequest {
        uploadFile: () => Promise<UploadedFile | null>;
        uploadFiles: () => Promise<UploadedFile[]>;
    }
}

export const uploadPlugin = fp(uploadPluginImpl, {
    name: 'upload',
    fastify: '5.x'
});

export default uploadPlugin;

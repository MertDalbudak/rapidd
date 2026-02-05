import 'dotenv/config';
import { getEnv } from './src/core/env';
import { buildApp } from './src/app';

/**
 * Application entry point
 * Builds Fastify app and starts server
 */
export async function start(): Promise<void> {
    const port = getEnv('PORT');
    const host = getEnv('HOST');

    try {
        const app = await buildApp();

        await app.listen({ port, host });
        console.log(`[Rapidd] Server running at http://${host}:${port}`);
        console.log(`[Rapidd] Environment: ${getEnv('NODE_ENV')}`);
    } catch (err) {
        console.error('[Startup Error]', (err as Error).message);
        process.exit(1);
    }
}

start();

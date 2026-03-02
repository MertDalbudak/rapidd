import 'dotenv/config';
import { getEnv } from './src/core/env';
import { buildApp } from './src/app';
import { Logger } from './src/utils/Logger';

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
        Logger.log('Server running', { host, port });
        Logger.log('Environment', { env: getEnv('NODE_ENV') });

        // Warn if running compiled build with development NODE_ENV
        if (process.argv[1]?.includes('/dist/') && getEnv('NODE_ENV') === 'development') {
            Logger.warn('Running compiled build with NODE_ENV=development. Set NODE_ENV=production in your .env for production use.');
        }
    } catch (err) {
        Logger.error(err as Error);
        process.exit(1);
    }
}

start();

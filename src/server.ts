import type { FastifyInstance } from 'fastify';
import { buildApp, markShuttingDown } from './app';
import { getEnv } from './core/env';
import { Logger } from './utils/Logger';
import type { RapiddOptions } from './types';

export interface StartOptions extends RapiddOptions {
    /** Default: PORT env (3000) */
    port?: number;
    /** Default: HOST env (0.0.0.0) */
    host?: string;
    /** How long SIGTERM/SIGINT may spend draining in-flight requests before a hard exit (ms). Env: SHUTDOWN_TIMEOUT_MS, default 10000 */
    shutdownTimeout?: number;
    /**
     * Keep serving this long after SIGTERM while readiness reports 503, before closing the
     * listener (ms) — gives load balancers / Kubernetes time to stop routing to this instance.
     * Env: SHUTDOWN_DELAY_MS, default 0
     */
    shutdownDelay?: number;
}

/**
 * Build the app, start listening, and shut down gracefully on SIGTERM / SIGINT:
 * readiness (/health/ready) turns 503, in-flight requests finish, onClose hooks run
 * (database pools, Redis, log flush), then the process exits. Container orchestrators
 * send SIGTERM before killing a pod — without this, connections are cut mid-request.
 */
export async function startServer(options: StartOptions = {}): Promise<FastifyInstance> {
    const port = options.port ?? getEnv('PORT');
    const host = options.host ?? getEnv('HOST');
    const shutdownTimeout = options.shutdownTimeout ?? parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);
    const shutdownDelay = options.shutdownDelay ?? parseInt(process.env.SHUTDOWN_DELAY_MS || '0', 10);

    const app = await buildApp(options);

    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (closing) return;
        closing = true;
        Logger.log('Shutting down', { signal });
        markShuttingDown(app);

        const timer = setTimeout(() => {
            Logger.error(`Graceful shutdown exceeded ${shutdownDelay + shutdownTimeout}ms — exiting`);
            process.exit(1);
        }, shutdownDelay + shutdownTimeout);
        timer.unref();

        try {
            if (shutdownDelay > 0) {
                await new Promise((resolve) => setTimeout(resolve, shutdownDelay));
            }
            await app.close();
            process.exit(0);
        } catch (err) {
            Logger.error(err as Error);
            process.exit(1);
        }
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ port, host });
    Logger.log('Server running', { host, port });
    Logger.log('Environment', { env: getEnv('NODE_ENV') });

    // Warn if running compiled build with development NODE_ENV
    if (process.argv[1]?.includes('/dist/') && getEnv('NODE_ENV') === 'development') {
        Logger.warn('Running compiled build with NODE_ENV=development. Set NODE_ENV=production in your .env for production use.');
    }

    return app;
}

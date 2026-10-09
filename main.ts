import 'dotenv/config';
import { startServer } from './src/server';
import { Logger } from './src/utils/Logger';

// Side-effect imports that must run before the server starts go here,
// e.g. model middleware: import './src/middleware/model';

/**
 * Application entry point.
 * Starts the server with graceful shutdown on SIGTERM/SIGINT. Pass options to
 * customize: startServer({ plugins: [...], errorReporter: (err) => Sentry.captureException(err) })
 */
export async function start(): Promise<void> {
    try {
        await startServer();
    } catch (err) {
        Logger.error(err as Error);
        process.exit(1);
    }
}

start();

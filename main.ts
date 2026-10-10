import './src/setup/env'; // ENV_FILE / .env into process.env — before anything reads its configuration
import { Logger } from './src/utils/Logger';
import { firstBoot, setupCommand } from './src/setup';

// Side-effect imports that must run before the server starts go here,
// e.g. model middleware: import './src/middleware/model';

/**
 * Application entry point. While the API cannot start (no database configured, Prisma client
 * missing, ...) the setup wizard is served instead, and the API starts once setup is done
 * (SETUP_WIZARD=off: exit with the error instead; SETUP_WIZARD=on: the wizard at every start).
 * `npm run setup` (main.ts setup) serves only the wizard and ends when it is finished.
 *
 * Pass options to customize: startServer({ plugins: [...], errorReporter: (err) => Sentry.captureException(err) })
 */
export async function start(): Promise<void> {
    try {
        if (process.argv.slice(2).includes('setup')) {
            await setupCommand();
            process.exit(0);
        }
        await firstBoot();
        // Loaded only now: the API reads its configuration while its modules load
        const { startServer } = await import('./src/server');
        await startServer();
    } catch (err) {
        Logger.error(err as Error);
        process.exit(1);
    }
}

start();

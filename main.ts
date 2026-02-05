import { buildApp } from './src/app';

async function start(): Promise<void> {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    try {
        const app = await buildApp();

        await app.listen({ port, host });
        console.log(`Server running on port ${port}`);
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();

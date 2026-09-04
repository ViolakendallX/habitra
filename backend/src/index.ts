import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(
    `[habitra] backend listening on http://localhost:${env.port} (${env.nodeEnv})`,
  );
});

function shutdown(signal: string): void {
  console.log(`[habitra] ${signal} received, shutting down`);
  server.close(() => {
    console.log('[habitra] server closed');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

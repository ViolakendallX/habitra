import { createApp } from './app.js';
import { env } from './config/env.js';
import { startAcpProvider, stopAcpProvider } from './services/virtualsProvider.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(
    `[habitra] backend listening on http://localhost:${env.port} (${env.nodeEnv})`,
  );

  // The ACP seller listener holds a long-lived SSE stream, so it is started
  // once per process — never per request. A failure here must not stop the API:
  // interventions simply stay on the mock backend.
  void startAcpProvider().catch((err: unknown) => {
    console.warn(
      `[habitra] ACP provider did not start: ${(err as Error)?.message ?? String(err)}`,
    );
  });
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[habitra] ${signal} received, shutting down`);

  try {
    await stopAcpProvider();
  } catch (err) {
    console.warn(
      `[habitra] ACP provider stop failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  server.close(() => {
    console.log('[habitra] server closed');
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

import express, { type Express, type Request, type Response } from 'express';

import { isProduction } from './config/env.js';
import { agentRouter } from './routes/agent.js';
import { analyticsRouter } from './routes/analytics.js';
import { walletRouter } from './routes/wallet.js';
import { blockchainRouter } from './routes/blockchain.js';
import { faucetRouter } from './routes/faucet.js';
import { authRouter } from './routes/auth.js';
import { devRouter } from './routes/dev.js';
import { habitsRouter } from './routes/habits.js';
import { challengesRouter } from './routes/challenges.js';
import { healthRouter } from './routes/health.js';
import { passwordResetRouter } from './routes/passwordReset.js';
import { registerFrontend } from './serveFrontend.js';

/**
 * Builds the Express application.
 *
 * Middleware and routers are registered here; index.ts is only responsible for
 * starting the HTTP server. API routes live under /api (PRD section 29).
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/auth', passwordResetRouter);
  app.use('/api/habits', habitsRouter);
  app.use('/api/challenges', challengesRouter);
  app.use('/api', analyticsRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/blockchain', blockchainRouter);
  app.use('/api/faucet', faucetRouter);

  // Dev-only routes (password-reset test capture, etc.). Never mounted in prod.
  if (!isProduction) {
    app.use('/api/dev', devRouter);
  }

  // Single-origin production: serve the built frontend from this same origin.
  // No-op in development (Vite owns the UI) and when the build output is absent.
  registerFrontend(app);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Route not found' });
  });

  return app;
}

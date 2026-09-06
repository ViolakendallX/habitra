import express, { type Express, type Request, type Response } from 'express';

import { isProduction } from './config/env.js';
import { agentRouter } from './routes/agent.js';
import { analyticsRouter } from './routes/analytics.js';
import { authRouter } from './routes/auth.js';
import { devRouter } from './routes/dev.js';
import { habitsRouter } from './routes/habits.js';
import { healthRouter } from './routes/health.js';
import { passwordResetRouter } from './routes/passwordReset.js';

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
  app.use('/api', analyticsRouter);
  app.use('/api/agent', agentRouter);

  // Dev-only routes (password-reset test capture, etc.). Never mounted in prod.
  if (!isProduction) {
    app.use('/api/dev', devRouter);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Route not found' });
  });

  return app;
}

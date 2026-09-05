import express, { type Express, type Request, type Response } from 'express';

import { analyticsRouter } from './routes/analytics.js';
import { authRouter } from './routes/auth.js';
import { habitsRouter } from './routes/habits.js';
import { healthRouter } from './routes/health.js';

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
  app.use('/api/habits', habitsRouter);
  app.use('/api', analyticsRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Route not found' });
  });

  return app;
}

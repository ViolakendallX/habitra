import { Router } from 'express';

import { env } from '../config/env.js';

export const healthRouter = Router();

/**
 * GET /health
 *
 * Liveness/readiness probe. Returns 200 while the process is running.
 * Database and dependency checks will be added when PostgreSQL is wired in.
 */
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'habitra-backend',
    environment: env.nodeEnv,
    timestamp: new Date().toISOString(),
    uptime: Number(process.uptime().toFixed(3)),
  });
});

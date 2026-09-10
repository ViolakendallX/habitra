import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';

/**
 * Serves the compiled frontend for a single-origin deployment.
 *
 * The frontend is built into `frontend/dist` (root-relative `/assets/...`, see
 * the Vite build output). In production we mount that directory on the same
 * Express origin as the `/api` routes so the HttpOnly auth cookie stays
 * first-party — no CORS, no cross-origin cookie configuration.
 *
 * This is intentionally inert everywhere else:
 *   - in development the dev server (Vite, :5173) owns the UI and proxies /api;
 *   - if the build output is absent we simply skip it, so the API is unchanged.
 *
 * The SPA fallback (`*` → index.html) is registered last and only for
 * non-/api paths, so it never shadows the JSON API.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/serveFrontend.ts -> backend/ ; ../frontend/dist -> the built SPA.
const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'frontend', 'dist');

export function registerFrontend(app: Express): void {
  if (!existsSync(FRONTEND_DIST)) {
    return;
  }

  app.use(express.static(FRONTEND_DIST, { index: 'index.html' }));

  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

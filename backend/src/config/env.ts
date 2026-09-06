/**
 * Central environment configuration.
 *
 * Values are read once at startup so the rest of the app never touches
 * process.env directly. DATABASE_URL configures Prisma/PostgreSQL, JWT_SECRET
 * signs and verifies the HttpOnly authentication cookie, and GEMINI_API_KEY
 * authenticates the Google Gemini API.
 *
 * Secrets are stored as-is and default to an empty string when absent; callers
 * that require a value check it and throw a descriptive error (see
 * `src/db/prisma.ts` and `src/auth/jwt.ts`). Never log these values.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// env.ts lives at <backend>/src/config/env.ts. The backend root is two levels up.
// (When compiled to dist/, the file is at <backend>/dist/config/env.js, which is
// still two levels up from <backend>, so this resolves identically in dev and prod.)
const backendRoot = path.resolve(__dirname, '..', '..');

/**
 * Default Sibyl Python interpreter: the isolated venv created for this project.
 * Override with SIBYL_PYTHON if your environment differs.
 */
function defaultSibylPython(): string {
  return process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
}

function toPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: toPort(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  // Password-reset email delivery (MVP). EMAIL_PROVIDER selects the backend;
  // `smtp` requires SMTP_* to be set, otherwise a dev capture provider is used.
  emailProvider: process.env.EMAIL_PROVIDER ?? '',
  emailFrom: process.env.EMAIL_FROM ?? '',
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: toInt(process.env.SMTP_PORT, 587),
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  // Base URL of the deployed frontend; the reset link is APP_URL + /reset-password?token=...
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  // Lifetime of a password-reset token, in minutes.
  resetTokenTtlMinutes: toInt(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES, 60),
  // --- Sibyl Memory (STEP 9 foundation; local-first, SQLite-backed, five-tier) ---
  // Opt-OUT, not opt-in: Sibyl is ON unless SIBYL_ENABLED is explicitly 'false'.
  // It was previously `=== 'true'`, which meant an unset variable silently
  // disabled memory — the backend shipped with memory off and the Agent always
  // reported "Memory not used". Set SIBYL_ENABLED=false to turn it off.
  //
  // When enabled, habit / behavior / preference signals are mirrored into a local
  // Sibyl store keyed by the authenticated user's id (tenant isolation via the
  // SDK). Every memory call is failure-safe: a missing interpreter, a timeout or
  // an SDK error is logged and swallowed, never propagated to the request.
  sibylEnabled: process.env.SIBYL_ENABLED !== 'false',
  // Local SQLite database path for Sibyl. Defaults to backend/.data/sibyl-memory.db.
  sibylDbPath:
    process.env.SIBYL_DB_PATH ??
    path.resolve(backendRoot, '.data', 'sibyl-memory.db'),
  // Python interpreter that has sibyl-memory-client installed (the isolated venv).
  sibylPython: process.env.SIBYL_PYTHON ?? defaultSibylPython(),
  // Path to the Python bridge script. Defaults to backend/scripts/sibyl_bridge.py.
  sibylBridgeScript:
    process.env.SIBYL_BRIDGE_SCRIPT ??
    path.resolve(backendRoot, 'scripts', 'sibyl_bridge.py'),
} as const;

export const isProduction = env.nodeEnv === 'production';

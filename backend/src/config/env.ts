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
} as const;

export const isProduction = env.nodeEnv === 'production';

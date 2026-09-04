/**
 * Central environment configuration.
 *
 * Values are read once at startup so the rest of the app never touches
 * process.env directly. DATABASE_URL configures Prisma/PostgreSQL and JWT_SECRET
 * signs and verifies the HttpOnly authentication cookie.
 */

function toPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: toPort(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
} as const;

export const isProduction = env.nodeEnv === 'production';

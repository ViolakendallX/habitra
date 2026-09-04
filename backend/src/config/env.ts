/**
 * Central environment configuration.
 *
 * Values are read once at startup so the rest of the app never touches
 * process.env directly. DATABASE_URL is declared here for the Prisma/PostgreSQL
 * phase (PRD Phase 2+) but is intentionally unused for now.
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
} as const;

export const isProduction = env.nodeEnv === 'production';

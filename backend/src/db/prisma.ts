import { PrismaPg } from '@prisma/adapter-pg';

import { env, isProduction } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Shared Prisma Client instance.
 *
 * Prisma 7 requires a driver adapter, so the client is wired to PostgreSQL
 * through `@prisma/adapter-pg` using the DATABASE_URL exposed by src/config/env.ts.
 *
 * In development the instance is cached on globalThis so `npm run dev`
 * (tsx watch) reuses a single connection pool across reloads instead of
 * leaking one pool per file change.
 */

if (!env.databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and configure the PostgreSQL connection string.',
  );
}

const globalForPrisma = globalThis as typeof globalThis & {
  habitraPrisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.databaseUrl });

  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.habitraPrisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.habitraPrisma = prisma;
}

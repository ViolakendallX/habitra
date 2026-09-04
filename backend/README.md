# Habitra — Backend

Node.js + Express + TypeScript backend for Habitra.

Foundation and database groundwork: a health-check route, the `User` model and
its first migration, and the registration endpoint (`POST /api/auth/register`).
Login and all other features are not implemented yet.

## Requirements

- Node.js 20.19+ (developed on Node 22)

## Setup

```bash
cd backend
npm install
cp .env.example .env   # optional
```

`.env` is optional — the scripts use `--env-file-if-exists`, so the server starts
without it and `PORT` falls back to `4000`.

## Run

Development (auto-restarts on file changes):

```bash
npm run dev
```

Production-style (compile, then run the build):

```bash
npm run build
npm start
```

## Scripts

| Script              | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `npm run dev`       | Run from source with `tsx watch`           |
| `npm run build`     | Compile TypeScript to `dist/`              |
| `npm start`         | Run the compiled server from `dist/`       |
| `npm run typecheck` | Type-check without emitting output         |
| `npm run prisma:validate` | Validate `prisma/schema.prisma`      |
| `npm run prisma:generate` | Regenerate the Prisma client         |

## Health check

```
GET http://localhost:4000/health
```

Response `200 OK`:

```json
{
  "status": "ok",
  "service": "habitra-backend",
  "environment": "development",
  "timestamp": "2026-09-04T09:00:00.000Z",
  "uptime": 12.345
}
```

## Database

Prisma is configured against PostgreSQL. The first model, `User`, exists and has
been migrated. No application code uses it yet.

| File                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `prisma/schema.prisma`  | Datasource (`postgresql`) + generator + models.           |
| `prisma7.config.ts`     | Prisma 7 config: schema path, migrations path, `DATABASE_URL`. |
| `prisma/migrations/`    | Generated migrations, committed to version control.       |
| `.env`                  | Holds the real `DATABASE_URL`.                            |

### User model

```prisma
model User {
  id           String   @id @default(cuid())
  name         String
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

`updatedAt` is maintained by Prisma at the client level, so it has no database
default — that is expected Prisma behaviour.

### Migrations

Apply pending migrations (used in CI, no shadow database needed):

```bash
npx prisma migrate deploy
```

Create the next migration while developing:

```bash
npx prisma migrate dev --name <name>
```

Migration SQL can also be previewed offline without touching the database:

```bash
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

Set your own credentials in `.env`:

```
DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/habitra?schema=public&sslmode=disable&connect_timeout=30"
```

### Note on Prisma 7 clients

Prisma 7's generated client requires a **driver adapter** to connect. When the
first service needs the database (PRD Phase 2, authentication), instantiate it
like this:

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
```

`@prisma/adapter-pg` and `pg` are installed; the reusable client lives in
`src/db/prisma.ts` and is instantiated exactly as shown above.

## Structure

```
src/
├── index.ts           # Entry point: starts the HTTP server, graceful shutdown
├── app.ts             # Builds the Express app (middleware + routers)
├── config/
│   └── env.ts         # Typed environment access (PORT, NODE_ENV, DATABASE_URL)
├── db/
│   └── prisma.ts      # Shared Prisma client (driver adapter: PrismaPg)
└── routes/
    ├── auth.ts        # POST /api/auth/register
    └── health.ts      # GET /health

prisma/
├── schema.prisma      # Datasource + generator + User model
└── migrations/
    ├── 20260904194003_init/migration.sql   # Creates the User table
    └── migration_lock.toml
prisma7.config.ts      # Prisma 7 configuration
```

## Planned growth (later phases)

- `prisma/schema.prisma` — further models and relations (Habit, Challenge, …)
- `src/routes/` — `/api/auth` (login/logout next), `/api/habits`, `/api/analytics`,
  `/api/agent`, `/api/memory`, `/api/challenges`, `/api/wallet`, `/api/blockchain`,
  `/api/telegram` (PRD section 29)
- `src/middleware/` — auth, validation, error handling
- `src/services/` — analytics, agent, Sibyl Memory, blockchain

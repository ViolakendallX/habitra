# Habitra — Backend

Node.js + Express + TypeScript backend for Habitra.

Stage 2 of the build (PRD Phase 1 — Foundation). Only the foundation exists:
one health-check route. No database, no auth, no features.

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

Prisma is configured against PostgreSQL. The foundation is in place; no models
exist yet.

| File                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `prisma/schema.prisma`  | Datasource (`postgresql`) + generator. Models go here.    |
| `prisma7.config.ts`     | Prisma 7 config: schema path, migrations path, `DATABASE_URL`. |
| `.env`                  | Holds the real `DATABASE_URL`.                            |

The generator writes the client to `src/generated/prisma` (gitignored). It is
generated on demand with `npm run prisma:generate` once models exist.

Set your own credentials in `.env`:

```
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/habitra?schema=public"
```

Migrations will live in `prisma/migrations` and are created with
`npx prisma migrate dev` once the first model is added.

## Structure

```
src/
├── index.ts           # Entry point: starts the HTTP server, graceful shutdown
├── app.ts             # Builds the Express app (middleware + routers)
├── config/
│   └── env.ts         # Typed environment access (PORT, NODE_ENV, DATABASE_URL)
└── routes/
    └── health.ts      # GET /health

prisma/
└── schema.prisma      # Datasource + generator, no models yet
prisma7.config.ts      # Prisma 7 configuration
```

## Planned growth (later phases)

- `prisma/schema.prisma` — models and relations, starting with `User` (PRD Phase 2)
- `prisma/migrations/` — generated migrations
- `src/routes/` — `/api/auth`, `/api/habits`, `/api/analytics`, `/api/agent`,
  `/api/memory`, `/api/challenges`, `/api/wallet`, `/api/blockchain`,
  `/api/telegram` (PRD section 29)
- `src/middleware/` — auth, validation, error handling
- `src/services/` — analytics, agent, Sibyl Memory, blockchain

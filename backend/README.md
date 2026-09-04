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

## Structure

```
src/
├── index.ts           # Entry point: starts the HTTP server, graceful shutdown
├── app.ts             # Builds the Express app (middleware + routers)
├── config/
│   └── env.ts         # Typed environment access (PORT, NODE_ENV, DATABASE_URL)
└── routes/
    └── health.ts      # GET /health
```

## Planned growth (later phases)

- `prisma/` — schema and migrations (PRD Phase 2+)
- `src/routes/` — `/api/auth`, `/api/habits`, `/api/analytics`, `/api/agent`,
  `/api/memory`, `/api/challenges`, `/api/wallet`, `/api/blockchain`,
  `/api/telegram` (PRD section 29)
- `src/middleware/` — auth, validation, error handling
- `src/services/` — analytics, agent, Sibyl Memory, blockchain

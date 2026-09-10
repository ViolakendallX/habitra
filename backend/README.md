# Habitra — Backend

Node.js + Express + TypeScript backend for Habitra.

The API implements the full accountability loop: authentication, habit tracking,
analytics, the Gemini-backed agent, **Sibyl Memory**, challenges, wallet linkage,
and Base on-chain escrow reconciliation.

| Concern | Where |
| --- | --- |
| Authentication (JWT cookie), password reset | `src/routes/auth.ts`, `src/routes/passwordReset.ts` |
| Habits, completions, history | `src/routes/habits.ts` |
| Analytics | `src/routes/analytics.ts`, `src/services/analytics.ts` |
| AI agent (Gemini) + Sibyl memory context | `src/routes/agent.ts`, `src/services/agent.ts` |
| **Sibyl Memory** (typed service) | `src/services/memory.ts`, `src/lib/sibylBridge.ts` |
| Challenges, evaluation, escrow | `src/routes/challenges.ts`, `src/services/challenges.ts`, `src/services/challengeEscrow.ts` |
| Wallet + on-chain reads/reconciliation | `src/routes/wallet.ts`, `src/routes/blockchain.ts`, `src/services/blockchain.ts` |
| Virtuals ACP v2 intervention transport | `src/services/virtuals.ts`, `virtualsAcp.ts`, `virtualsProvider.ts` |

Mounted routes (`src/app.ts`): `/health`, `/api/auth`, `/api/habits`,
`/api/challenges`, `/api/analytics`, `/api/agent`, `/api/wallet`,
`/api/blockchain`, and `/api/dev` (development only).

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

Prisma is configured against PostgreSQL. The following models exist and have
been migrated:

| Model | Purpose |
| --- | --- |
| `User` | Authentication and account identity |
| `Habit` | A tracked habit (frequency, target, preferred time, status) |
| `HabitCompletion` | One row per habit per day (completed / missed, miss reason) |
| `PasswordResetToken` | Password-reset tokens |
| `Challenge` | A commitment with dates, stake and outcome |
| `ChallengeHabit` | Links a challenge to the habits it covers |
| `Wallet` | A user's linked on-chain address (with `chainId`) |
| `Transaction` | On-chain economic events (`FUND` / `CLAIM` / `PENALTY`) and confirmation state |

| File                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `prisma/schema.prisma`  | Datasource (`postgresql`) + generator + models.           |
| `prisma7.config.ts`     | Prisma 7 config: schema path, migrations path, `DATABASE_URL`. |
| `prisma/migrations/`    | Generated migrations, committed to version control.       |
| `.env`                  | Holds the real `DATABASE_URL` and `JWT_SECRET` (never commit). |

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

### Habit model

```prisma
model Habit {
  id            String   @id @default(cuid())
  userId        String
  name          String
  description   String?
  frequency     String
  target        Int
  preferredTime String?
  status        String   @default("ACTIVE")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

`frequency` and `status` are plain `String` columns rather than Prisma enums, so
the generated client exports no enums. The allowed values (`DAILY`/`WEEKLY` for
`frequency`, `ACTIVE` at creation for `status`) are enforced by the route's Zod
schema and by the code that writes the row.

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

## Authentication (PRD section 6)

The routes live under the `/api/auth` router (`src/routes/auth.ts`). Registration
and login share a `normalizeEmail` helper (trim + lowercase) so
`  ADA@Example.COM ` and `ada@example.com` resolve to the same account. All user
responses use a `publicUserFields` Prisma `select` that never returns
`passwordHash`.

### Registration — `POST /api/auth/register`

```json
{ "name": "Ada Lovelace", "email": "ada@example.com", "password": "supersecret1" }
```

- Validates with Zod (name 1–100, email, password 8–72 chars), then normalizes.
- Rejects an existing email with `409 Conflict`. Hashes the password with bcrypt
  (cost 12) before saving.
- Success → `201` with `{ id, name, email, createdAt, updatedAt }` (no `passwordHash`).

### Login — `POST /api/auth/login`

```json
{ "email": "ada@example.com", "password": "supersecret1" }
```

- Validates with Zod, then normalizes the email the same way as registration.
- Finds the user by normalized email, then verifies the password with
  `bcrypt.compare` against the stored hash.
- Unknown email **and** wrong password both return the same generic `401`:
  `{"status":"error","message":"Invalid email or password."}` — the response never
  reveals which one failed (no account enumeration). No passwords or hashes are logged.
- Success → `200` with `{ id, name, email, createdAt, updatedAt }` (no `passwordHash`)
  and sets a seven-day HS256 JWT in the `habitra_auth` cookie.

### Authenticated user — `GET /api/auth/me`

Uses the reusable `requireAuth` middleware to verify the JWT cookie and load the
current user from PostgreSQL. Missing, expired, malformed, tampered, and
user-not-found states all return the same generic `401` response. Success → `200`
with `{ id, name, email, createdAt, updatedAt }` and never `passwordHash`.

### Logout — `POST /api/auth/logout`

Clears `habitra_auth` by emitting an expired cookie with matching path, SameSite,
and Secure attributes. JWT sessions are stateless, so no database row is deleted.

### JWT cookie

- JWT payload: only the user id in the standard `sub` claim, plus `iat` and `exp`.
- Algorithm: HS256; lifetime: seven days; secret: `JWT_SECRET` from the environment.
- Cookie: `HttpOnly`, `Path=/`, seven-day `Max-Age`; `SameSite=Lax` and non-Secure
  for local HTTP development; `SameSite=None` + `Secure` in production for the
  expected separately hosted frontend/API.
- The JWT is never placed in response JSON, localStorage, or frontend-readable code.

Refresh tokens and OAuth are intentionally not implemented.

## Habits (PRD sections 7–8)

The routes live under the `/api/habits` router (`src/routes/habits.ts`).

### List habits — `GET /api/habits`

Requires authentication (`requireAuth`). Returns **only** the authenticated
user's habits, newest first (`createdAt` descending, `id` descending as a
tiebreaker so habits created in the same millisecond still sort stably).

- Success → `200` with `{ status: "success", data: { habits: [...] } }`. A user
  with no habits gets `200` and `"habits": []` — never a 404.
- The `userId` filter always comes from the session cookie resolved by
  `requireAuth`. **No query parameter, body field, or header is read**, so
  `GET /api/habits?userId=<someone-else>` is simply ignored and cannot expose
  another user's rows.
- Missing, expired, or tampered session → the same generic `401` as the rest of the API.
- Database failure → `500` with a generic message; nothing is logged or returned.

### Create habit — `POST /api/habits`

Requires authentication (`requireAuth`). The owner is always taken from the
authenticated user; a `userId` in the request body is ignored.

```json
{
  "name": "Morning Workout",
  "description": "30 minutes of exercise",
  "frequency": "DAILY",
  "target": 1,
  "preferredTime": "07:00"
}
```

Validation (Zod v4), applied after trimming:

| Field           | Rule                                                     |
| --------------- | -------------------------------------------------------- |
| `name`          | Required, trimmed, must not be empty, max 100 characters  |
| `description`   | Optional/nullable, max 500 characters                    |
| `frequency`     | Required, exactly `DAILY` or `WEEKLY`                    |
| `target`        | Required, integer greater than 0                         |
| `preferredTime` | Optional/nullable, 24-hour `HH:mm` when provided         |

- Success → `201` with `{ status, data: { habit } }`. `status` is stored as
  `ACTIVE`, and an omitted or empty `description`/`preferredTime` is stored as `NULL`.
- Validation failure → `400` with `z.flattenError(...).fieldErrors`. A
  whitespace-only name fails because it is trimmed to empty before the length check.
- Missing, expired, or tampered session → the same generic `401` as the rest of the API.
- Database failure → `500` with a generic message. Errors are not logged or
  returned, so SQL, stack traces, and credentials cannot leak.

Only the habit's own columns are selected, so no user record — and never a
`passwordHash` — appears in the response.

## Structure

```
src/
├── index.ts           # Entry point: starts the HTTP server, graceful shutdown
├── app.ts             # Builds the Express app (middleware + routers)
├── auth/
│   ├── jwt.ts         # JWT signing/verification + cookie options
│   └── select.ts      # Safe public-user shape and Prisma select
├── config/
│   └── env.ts         # Typed environment access (incl. Sibyl, Virtuals, Base)
├── contracts/
│   └── abi.ts         # Generated `as const` ABIs (BEES, HabitraChallengeEscrow)
├── db/
│   └── prisma.ts      # Shared Prisma client (driver adapter: PrismaPg)
├── lib/
│   └── sibylBridge.ts # Node -> Python transport for Sibyl Memory
├── middleware/
│   └── auth.ts        # Reusable requireAuth middleware
├── routes/
│   ├── agent.ts       # /api/agent — recommendation + outcome recording
│   ├── analytics.ts   # /api/analytics
│   ├── auth.ts        # register, login, me, and logout
│   ├── blockchain.ts  # /api/blockchain — chain status
│   ├── challenges.ts  # /api/challenges — lifecycle + stake
│   ├── dev.ts         # /api/dev — development only
│   ├── habits.ts      # /api/habits — CRUD, complete, miss, history
│   ├── health.ts      # GET /health
│   ├── passwordReset.ts
│   └── wallet.ts      # /api/wallet — linked wallet
└── services/
    ├── agent.ts              # Gemini reasoning + agent context
    ├── analytics.ts
    ├── blockchain.ts
    ├── blockchainPersistence.ts
    ├── challengeEscrow.ts    # Applies the economic consequence
    ├── challenges.ts         # Sole authority for pass/fail
    ├── memory.ts             # Typed Sibyl Memory service
    ├── virtuals.ts
    ├── virtualsAcp.ts        # ACP v2 transport
    └── virtualsProvider.ts   # ACP v2 seller listener

prisma/
├── schema.prisma      # Datasource + generator + all models
└── migrations/        # Generated migrations, committed to version control
prisma7.config.ts      # Prisma 7 configuration
scripts/               # Test suites and the Sibyl Python bridge
```

## Services

- **`services/analytics.ts`** — completion rates, streaks, most/least consistent habits, common miss reasons.
- **`services/agent.ts`** — builds the agent context (PostgreSQL facts **plus Sibyl memories**), calls Gemini, validates the response, and persists the recommendation to Sibyl.
- **`services/memory.ts`** — the only place the app talks to Sibyl. Handles feature flagging, per-user tenant isolation, secret refusal, and failure-safe degradation.
- **`services/challenges.ts`** — challenge lifecycle and the **sole** authority for pass/fail.
- **`services/challengeEscrow.ts`** — applies the economic consequence; never changes the verdict.
- **`services/blockchain.ts` / `blockchainPersistence.ts`** — viem reads, transaction confirmation and reconciliation.
- **`services/virtuals.ts` / `virtualsAcp.ts` / `virtualsProvider.ts`** — Virtuals ACP v2 intervention transport and seller listener.

## Sibyl Memory

Memory is enabled by default (`SIBYL_ENABLED` is opt-*out*) and is failure-safe:
a memory outage is logged and swallowed, never propagated. The most important
call sites are:

| Direction | Call site |
| --- | --- |
| Write completion/miss event | `src/routes/habits.ts:557` |
| Write habit behaviour profile | `src/routes/habits.ts:566` |
| Write recommendation outcome | `src/services/agent.ts:566-573` |
| Merge accept/helpful outcome | `src/routes/agent.ts:97` |
| Read memories into agent context | `src/services/agent.ts:474-475`, `458`, `515-521` |

See the [root README](../README.md) for why memory is load-bearing.

## Testing

```bash
npm run typecheck
npm run test:regression_api
npm run test:challenges_service && npm run test:challenges_api
npm run test:wallet_api && npm run test:blockchain_persistence
npm run test:challenge_escrow_confirm
npm run test:agent && npm run test:sibyl && npm run test:habit_memory
npm run test:learning_loop
npm run test:virtuals_intervention && npm run test:virtuals_acp_v2 && npm run test:virtuals_provider
```

`npm run test:challenge_escrow` asserts `DEMO_CHAIN_MODE=true` and therefore
fails under a live configuration. Run it with `DEMO_CHAIN_MODE=true`, or use
`test:challenge_escrow_confirm` for the live path (48/48).

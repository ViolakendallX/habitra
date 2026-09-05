# Habitra — Backend

Node.js + Express + TypeScript backend for Habitra.

Foundation, database groundwork, and authentication: a health-check route, the
`User` model and its first migration, registration (`POST /api/auth/register`),
login (`POST /api/auth/login`), a JWT session layer with `GET /api/auth/me` and
`POST /api/auth/logout`, the reusable `requireAuth` middleware, and habit
creation (`POST /api/habits`).

Editing, deleting, pausing, completing, and all other habit features are not
implemented yet.

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

Prisma is configured against PostgreSQL. Two models exist and have been migrated:
`User`, used by authentication, and `Habit`, created through `POST /api/habits`.

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
│   └── env.ts         # Typed environment access (PORT, DATABASE_URL, JWT_SECRET)
├── db/
│   └── prisma.ts      # Shared Prisma client (driver adapter: PrismaPg)
├── middleware/
│   └── auth.ts        # Reusable requireAuth middleware
└── routes/
    ├── auth.ts        # register, login, me, and logout
    ├── habits.ts      # POST /api/habits (create)
    └── health.ts      # GET /health

prisma/
├── schema.prisma      # Datasource + generator + User and Habit models
└── migrations/
    ├── 20260904194003_init/migration.sql      # Creates the User table
    ├── 20260904225128_add_habit/migration.sql # Creates the Habit table
    └── migration_lock.toml
prisma7.config.ts      # Prisma 7 configuration
```

## Planned growth (later phases)

- `prisma/schema.prisma` — further models and relations (HabitCompletion, Challenge, …)
- `src/routes/` — the rest of `/api/habits` (list, edit, delete, pause/resume,
  complete, miss, history) plus `/api/analytics`, `/api/agent`, `/api/memory`,
  `/api/challenges`, `/api/wallet`, `/api/blockchain`, `/api/telegram` (PRD section 29)
- `src/middleware/` — validation and further request guards (authentication exists)
- `src/services/` — analytics, agent, Sibyl Memory, blockchain

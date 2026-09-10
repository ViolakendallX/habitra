# Habitra — Frontend

React + Vite + TypeScript frontend for Habitra.

The app is fully wired to the backend: authentication, habit tracking,
analytics, the AI agent, challenges, wallet and on-chain escrow status.

## Requirements

- Node.js 20.19+ (developed on Node 22)

## Setup

```bash
cd frontend
npm install
cp .env.example .env   # optional; defaults to the local backend
```

## Run

```bash
npm run dev
```

The dev server starts on **http://localhost:5173**.

> Use `localhost`, not `127.0.0.1`. Vite binds IPv6 `[::1]` only, so
> `http://127.0.0.1:5173` will not connect.

The Vite dev server proxies `/api` to the backend on port `4000`.

## Other scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Run the TypeScript compiler, no output |
| `npm run test:register-ui` | Registration flow UI test |
| `npm run smoke:register` | Registration smoke check |
| `npm run test:agent-ui` | Agent page UI test |
| `npm run smoke:agent-ui` | Agent page smoke check |
| `npm run test:challenges-ui` | Challenges flow UI test |
| `npm run test:dashboard-ui` | Dashboard UI test |
| `npm run test:notifications-ui` | Notifications UI test |

The UI tests drive a real browser via `playwright-core` and point at a running
dev server. They default to `http://localhost:5173`; override with
`APP_BASE_URL` if needed.

## Pages

| Page | Purpose |
| --- | --- |
| `Login` / `Register` | Email + password authentication (JWT in an HttpOnly cookie) |
| `ForgotPassword` / `ResetPassword` | Password reset flow |
| `Dashboard` | Overview: habits, completions, analytics, challenges, escrow and wallet status |
| `Habits` | Create, edit, pause and complete habits |
| `Challenges` | Create challenges and lock a BEES stake |
| `Agent` | Request an AI recommendation and record whether it helped |
| `Wallet` | Linked wallet address and on-chain status |
| `Settings` | Account settings |

## Structure

```
src/
├── main.tsx            # React entry point
├── App.tsx             # Routing; AppLayout toggles the dark theme for protected pages
├── components/
│   ├── Navigation.tsx        # Top navigation
│   ├── NotificationBell.tsx  # Notification centre (client-side)
│   ├── ProtectedRoute.tsx    # Redirects unauthenticated users to /login
│   ├── StatTile.tsx          # Dashboard metric tile
│   └── WeekHeatmap.tsx       # Weekly completion heatmap
├── lib/
│   ├── http.ts         # fetch wrapper: credentials: 'include', throws ApiError
│   ├── types.ts        # Backend payload types (dates are strings, never Date)
│   └── contracts/      # Generated ABIs
├── pages/              # Page components listed above
└── styles/
    └── global.css      # Design tokens; dark theme scoped to protected pages
```

## Notes

- Authenticated pages are wrapped in `AppLayout`, which sets
  `document.body.dataset.theme = 'dark'`. Public auth pages stay light.
- `lib/http.ts` sends `credentials: 'include'` and never reads the auth cookie —
  it is `HttpOnly` and inaccessible to JavaScript by design.
- Notifications are currently client-side only (local storage), not server-driven.

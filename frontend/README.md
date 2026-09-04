# Habitra — Frontend

React + Vite + TypeScript frontend for Habitra.

Stage 1 of the build (PRD Phase 1 — Foundation). Only the foundation exists:
no auth, no dashboard, no backend integration.

## Requirements

- Node.js 20.19+ (developed on Node 22)

## Setup

```bash
cd frontend
npm install
cp .env.example .env   # optional until the backend exists
```

## Run

```bash
npm run dev
```

The dev server starts on http://localhost:5173.

## Other scripts

| Script              | Purpose                                |
| ------------------- | -------------------------------------- |
| `npm run dev`       | Start the Vite dev server              |
| `npm run build`     | Type-check and build for production    |
| `npm run preview`   | Serve the production build locally     |
| `npm run typecheck` | Run the TypeScript compiler, no output |

## Structure

```
src/
├── main.tsx          # React entry point
├── App.tsx           # App shell
├── lib/
│   ├── api.ts        # API base URL (VITE_API_BASE_URL)
│   └── routes.ts     # Planned routes from PRD section 4
├── pages/            # Placeholder page components, not wired yet
└── styles/
    └── global.css    # Global styles and design tokens
```

Routing, state management, and API clients are intentionally omitted until
their phase in the PRD build order.

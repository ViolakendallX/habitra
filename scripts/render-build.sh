#!/usr/bin/env bash
# Render build script for Habitra — single-origin Web Service.
#
# This runs as the service `buildCommand`. It is idempotent and safe to re-run.
# The service itself is a Node web service that ALSO serves the compiled
# frontend from the same origin (see backend/src/serveFrontend.ts), so there is
# no cross-origin cookie / CORS problem and no separate static host is needed.
#
# Sibyl Memory is a Python SDK bridged from Node. We build an isolated venv here
# so `SIBYL_PYTHON` (default: backend/.venv/bin/python) resolves at runtime.
set -euo pipefail

echo "==> [habitra] Render build starting"

echo "==> Installing backend dependencies"
npm --prefix backend install

echo "==> Prisma: generating client"
npm --prefix backend run prisma:generate

echo "==> Prisma: applying migrations to the database"
npm --prefix backend run prisma:migrate:deploy

echo "==> Installing frontend dependencies"
npm --prefix frontend install

echo "==> Building frontend (VITE_API_BASE_URL is baked in at build time)"
npm --prefix frontend run build

echo "==> Building backend (tsc -> dist/)"
npm --prefix backend run build

echo "==> Setting up Sibyl Python venv (sibyl-memory-client)"
if command -v python3 >/dev/null 2>&1; then
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install --quiet --upgrade pip
  backend/.venv/bin/pip install --quiet "sibyl-memory-client==0.8.0"
  echo "==> Sibyl venv ready:"
  backend/.venv/bin/python -c "import sibyl_memory_client, sys; print('    sibyl-memory-client imported, python', sys.version.split()[0])"
else
  echo "WARNING: python3 not found in the build image; Sibyl memory will be"
  echo "         disabled at runtime. The app is failure-safe and still runs."
fi

echo "==> [habitra] Render build complete"

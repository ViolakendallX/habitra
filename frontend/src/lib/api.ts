/**
 * Base URL for the Node.js API (see PRD section 29).
 * The backend is not built yet — this is the single place the frontend will
 * read its API target from once Phase 2 starts.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

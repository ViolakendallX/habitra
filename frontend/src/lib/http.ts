import { API_BASE_URL } from './api';
import type { ApiEnvelope, ApiErrorBody, ApiMessageEnvelope } from './types';

/**
 * Minimal fetch wrapper for the Habitra API.
 *
 * It exists so no page has to repeat the same three things: prefixing the API
 * base URL (a relative `/api`, which Vite proxies to the backend in dev),
 * sending the session cookie, and turning a non-2xx response into something a
 * component can render.
 *
 * Two invariants:
 *
 * - `credentials: 'include'` is always set. The session is an HttpOnly JWT
 *   cookie, so it is attached by the browser and is *not readable from JS* —
 *   this module never reads, stores, logs or returns a token, and never puts a
 *   credential in a URL or a request body it constructs.
 * - Nothing is logged. Error messages come straight from the server's own
 *   envelope, which is already written to be safe to show a user.
 */

export type RequestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: RequestMethod;
  /** JSON-serialisable body. Omit entirely for GET/DELETE. */
  body?: unknown;
}

/** Used when the server is unreachable, so there is no HTTP status. */
export const NETWORK_ERROR_STATUS = 0;

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Error thrown for any non-2xx response, an error envelope inside a 2xx, or a
 * failed request. `status` is the HTTP code (0 when the server never replied),
 * and `fieldErrors` carries per-field validation messages when the backend
 * returns a 400.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;

  constructor(message: string, status: number, fieldErrors: Record<string, string[]> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }

  /** Convenience for forms: the first message attached to a field, if any. */
  fieldError(field: string): string | undefined {
    return this.fieldErrors[field]?.[0];
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function buildUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Non-JSON body (an HTML error page, an empty 200): treat as no payload.
    return null;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object') {
    const candidate = body as Partial<ApiErrorBody>;
    const message = candidate.message?.trim() ? candidate.message : FALLBACK_MESSAGE;
    const errors = candidate.errors;

    return new ApiError(
      message,
      status,
      errors && typeof errors === 'object' ? errors : {},
    );
  }

  return new ApiError(FALLBACK_MESSAGE, status);
}

/** True when the payload is an error envelope, whatever the HTTP status was. */
function isErrorEnvelope(body: unknown): boolean {
  return Boolean(body) && typeof body === 'object' && (body as { status?: unknown }).status === 'error';
}

async function send(path: string, options: ApiRequestOptions): Promise<unknown> {
  const { method = 'GET', body } = options;

  let response: Response;

  try {
    response = await fetch(buildUrl(path), {
      method,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    });
  } catch {
    throw new ApiError(
      'Unable to reach the server. Check your connection and try again.',
      NETWORK_ERROR_STATUS,
    );
  }

  const payload = await readBody(response);

  if (!response.ok || isErrorEnvelope(payload)) {
    throw toApiError(response.status, payload);
  }

  return payload;
}

/**
 * Calls the API and resolves with the `data` of a success envelope.
 *
 * For the routes that return only a `message` (logout, forgot-password,
 * reset-password) there is no `data`, so use `apiRequestMessage` instead.
 */
export async function apiRequest<TData>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<TData> {
  const payload = await send(path, options);
  return (payload as ApiEnvelope<TData> | null)?.data as TData;
}

/** Calls the API and resolves with the `message` of a success envelope. */
export async function apiRequestMessage(
  path: string,
  options: ApiRequestOptions = {},
): Promise<string> {
  const payload = await send(path, options);
  const envelope = payload as ApiMessageEnvelope | ApiEnvelope<unknown> | null;

  return envelope?.message ?? '';
}

/** Small ergonomic wrapper so call sites read like `api.post('/habits', body)`. */
export const api = {
  get: <TData>(path: string) => apiRequest<TData>(path, { method: 'GET' }),

  post: <TData>(path: string, body?: unknown) =>
    apiRequest<TData>(path, { method: 'POST', body }),

  patch: <TData>(path: string, body?: unknown) =>
    apiRequest<TData>(path, { method: 'PATCH', body }),

  remove: <TData>(path: string) => apiRequest<TData>(path, { method: 'DELETE' }),

  message: (path: string, options: ApiRequestOptions = {}) =>
    apiRequestMessage(path, { ...options }),
};

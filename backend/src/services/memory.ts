/**
 * memory.ts — typed Sibyl Memory service for Habitra.
 *
 * This is the ONLY place the application talks to Sibyl. It wraps the low-level
 * Python bridge (lib/sibylBridge.ts) with:
 *
 *  - Feature flagging: when SIBYL_ENABLED is false, every call is a safe no-op
 *    that resolves to a benign result. The app behaves exactly as before memory
 *    existed (no Python spawned, no throw).
 *  - Tenant isolation: the caller's Habitra userId is passed straight through as
 *    the Sibyl tenant_id. The SDK enforces per-tenant isolation, so one user can
 *    never read another's memories.
 *  - Failure safety: a bridge error (timeout, spawn failure, SDK error) is logged
 *    at warn level and swallowed — memory is an augmentation, never a hard
 *    dependency of a request.
 *  - Secret refusal: this service refuses to store any value whose key or nested
 *    key looks like a credential (password, hash, jwt, token, api key, secret,
 *    cookie, authorization, private key, credentials). Behavioral / preference /
 *    recommendation signals only.
 *
 * SECURITY: never pass secrets here. Do not write passwords, password hashes,
 * JWTs, API keys, session cookies, or raw auth tokens into Sibyl.
 *
 * NOTE: This is the STEP 9 foundation only. No habit hooks call these functions
 * yet, and there are no /api/memory routes. Those are later phases.
 */

import { env } from '../config/env.js';
import { runSibylOp, type SibylError } from '../lib/sibylBridge.js';

export interface MemoryMeta {
  /** true when the value was actually stored/retrieved (not a no-op). */
  remembered: boolean;
  /** false only on a genuine error; disabled mode resolves to ok:true. */
  ok: boolean;
  /** present when SIBYL_ENABLED is false (intentional no-op). */
  disabled?: boolean;
  /** populated on failure for observability. */
  error?: SibylError;
}

export interface MemoryWriteResult extends MemoryMeta {}

export interface MemoryEntity {
  category: string;
  name: string;
  body: unknown;
  status?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemorySearchResult extends MemoryMeta {
  items: MemoryEntity[];
}

export interface MemoryRecallResult extends MemoryMeta {
  entity: MemoryEntity | null;
}

// --- Input shapes (what the later habit hooks / agent will pass) ---

export interface CompletionEventInput {
  habitId: string;
  habitName: string;
  outcome: 'completed' | 'missed';
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  missReason?: string | null;
  streak?: number | null;
  source?: string;
}

export interface HabitBehaviorProfile {
  habitId: string;
  habitName: string;
  bestTimeOfDay?: string | null;
  commonMissReasons?: string[];
  cadence?: string | null;
  notes?: string | null;
}

export interface RecommendationOutcome {
  recommendationId: string;
  habitId?: string | null;
  accepted?: boolean | null;
  helpful?: boolean | null;
  text?: string | null;
  source?: string;
}

// --- Secret refusal ---

const SECRET_KEY_FRAGMENTS = [
  'password',
  'passhash',
  'hash',
  'jwt',
  'token',
  'apikey',
  'api_key',
  'secret',
  'cookie',
  'authorization',
  'authtoken',
  'privatekey',
  'private_key',
  'credentials',
  'credential',
];

function findSecretKey(value: unknown, prefix: string): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSecretKey(item, prefix);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SECRET_KEY_FRAGMENTS.some((frag) => lowerKey.includes(frag))) {
        return `${prefix}${key}`;
      }
      const found = findSecretKey(child, `${prefix}${key}.`);
      if (found) return found;
    }
  }
  return null;
}

function refuseIfSecret(args: Record<string, unknown>): SibylError | null {
  for (const [key, value] of Object.entries(args)) {
    const lowerKey = key.toLowerCase();
    if (SECRET_KEY_FRAGMENTS.some((frag) => lowerKey.includes(frag))) {
      return {
        type: 'RefusedSecret',
        message: `refusing to store field '${key}' which looks like a secret`,
      };
    }
    const found = findSecretKey(value, `${key}.`);
    if (found) {
      return {
        type: 'RefusedSecret',
        message: `refusing to store nested field '${found}' which looks like a secret`,
      };
    }
  }
  return null;
}

// --- Internal helpers ---

function disabledMeta(): MemoryMeta {
  return { remembered: false, ok: true, disabled: true };
}

function okMeta(): MemoryMeta {
  return { remembered: true, ok: true };
}

function toMeta(response: { ok: false; error: SibylError }): MemoryMeta {
  return { remembered: false, ok: false, error: response.error };
}

function mapEntity(raw: unknown): MemoryEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.category !== 'string' || typeof e.name !== 'string') return null;
  return {
    category: e.category,
    name: e.name,
    body: e.body ?? null,
    status: e.status === null ? null : typeof e.status === 'string' ? e.status : undefined,
    createdAt: typeof e.created_at === 'string' ? e.created_at : undefined,
    updatedAt: typeof e.updated_at === 'string' ? e.updated_at : undefined,
  };
}

function warn(op: string, err: SibylError): void {
  // Never log secrets; only the typed error and message.
  console.warn(`[sibyl-memory] ${op} failed: ${err.type} - ${err.message}`);
}

function notFoundMeta(): MemoryMeta {
  return { remembered: false, ok: true };
}

// --- Public API ---

/**
 * Record a habit completion / miss as a COLD-tier event. Safe no-op when disabled.
 */
export async function recordCompletionEvent(
  userId: string,
  input: CompletionEventInput,
): Promise<MemoryWriteResult> {
  if (!env.sibylEnabled) return disabledMeta();

  const secretCheck = refuseIfSecret({
    evaluated: {
      habitId: input.habitId,
      habitName: input.habitName,
      outcome: input.outcome,
      date: input.date,
      missReason: input.missReason ?? null,
      streak: input.streak ?? null,
    },
  });
  if (secretCheck) {
    warn('recordCompletionEvent', secretCheck);
    return { remembered: false, ok: false, error: secretCheck };
  }

  const response = await runSibylOp({
    op: 'write_event',
    tenantId: userId,
    args: {
      evaluated: {
        habitId: input.habitId,
        habitName: input.habitName,
        outcome: input.outcome,
        date: input.date,
        missReason: input.missReason ?? null,
        streak: input.streak ?? null,
      },
      extra: { source: input.source ?? 'habitra' },
    },
  });

  if (!response.ok) {
    warn('recordCompletionEvent', response.error);
    return toMeta(response);
  }
  return okMeta();
}

/**
 * Save a per-habit behavioral profile as a WARM entity (category=habit_behavior).
 */
export async function saveHabitBehaviorProfile(
  userId: string,
  habitId: string,
  profile: HabitBehaviorProfile,
): Promise<MemoryWriteResult> {
  if (!env.sibylEnabled) return disabledMeta();

  const secretCheck = refuseIfSecret({ body: profile });
  if (secretCheck) {
    warn('saveHabitBehaviorProfile', secretCheck);
    return { remembered: false, ok: false, error: secretCheck };
  }

  const response = await runSibylOp({
    op: 'set_entity',
    tenantId: userId,
    args: { category: 'habit_behavior', name: habitId, body: profile },
  });

  if (!response.ok) {
    warn('saveHabitBehaviorProfile', response.error);
    return toMeta(response);
  }
  return okMeta();
}

/**
 * Save a user preference as a WARM entity (category=user_preference).
 * `value` may be any JSON-serializable payload (no secrets). Primitive values
 * (string/number/boolean) are wrapped into `{ value: ... }` because the Sibyl
 * SDK requires an entity body to be a dict or list; object/array values are
 * stored as-is.
 */
export async function saveUserPreference(
  userId: string,
  key: string,
  value: unknown,
): Promise<MemoryWriteResult> {
  if (!env.sibylEnabled) return disabledMeta();

  const body = value !== null && typeof value === 'object' ? value : { value };

  const secretCheck = refuseIfSecret({ key, value: body });
  if (secretCheck) {
    warn('saveUserPreference', secretCheck);
    return { remembered: false, ok: false, error: secretCheck };
  }

  const response = await runSibylOp({
    op: 'set_entity',
    tenantId: userId,
    args: { category: 'user_preference', name: key, body },
  });

  if (!response.ok) {
    warn('saveUserPreference', response.error);
    return toMeta(response);
  }
  return okMeta();
}

/**
 * Save the outcome of an AI recommendation as a WARM entity (category=recommendation).
 */
export async function saveRecommendationOutcome(
  userId: string,
  outcome: RecommendationOutcome,
): Promise<MemoryWriteResult> {
  if (!env.sibylEnabled) return disabledMeta();

  const secretCheck = refuseIfSecret({ body: outcome });
  if (secretCheck) {
    warn('saveRecommendationOutcome', secretCheck);
    return { remembered: false, ok: false, error: secretCheck };
  }

  const response = await runSibylOp({
    op: 'set_entity',
    tenantId: userId,
    args: { category: 'recommendation', name: outcome.recommendationId, body: outcome },
  });

  if (!response.ok) {
    warn('saveRecommendationOutcome', response.error);
    return toMeta(response);
  }
  return okMeta();
}

/**
 * Full-text search the authenticated user's memories (FTS5). Safe no-op when disabled.
 */
export async function searchMemories(
  userId: string,
  query: string,
  options?: { limit?: number; category?: string },
): Promise<MemorySearchResult> {
  if (!env.sibylEnabled) return { ok: true, disabled: true, remembered: false, items: [] };

  const args: Record<string, unknown> = { query };
  if (options?.limit) args.limit = options.limit;
  if (options?.category) args.category = options.category;

  const response = await runSibylOp({
    op: 'search_entities',
    tenantId: userId,
    args,
  });

  if (!response.ok) {
    warn('searchMemories', response.error);
    return { ok: false, remembered: false, items: [], error: response.error };
  }

  const data = response.data as { results?: unknown[] };
  const items = Array.isArray(data.results)
    ? (data.results.map(mapEntity).filter((e): e is MemoryEntity => e !== null))
    : [];
  return { ok: true, remembered: true, items };
}

/**
 * Recall a single WARM/REFERENCE entity by category+name for the user.
 * Returns entity:null (ok:true) when it does not exist.
 */
export async function recallEntity(
  userId: string,
  category: string,
  name: string,
): Promise<MemoryRecallResult> {
  if (!env.sibylEnabled) return { ok: true, disabled: true, remembered: false, entity: null };

  const response = await runSibylOp({
    op: 'get_entity',
    tenantId: userId,
    args: { category, name },
  });

  if (!response.ok) {
    // NotFoundError is expected when the entity has never been written.
    if (response.error?.type === 'NotFoundError') {
      return { ok: true, remembered: false, entity: null };
    }
    warn('recallEntity', response.error);
    return { ok: false, remembered: false, entity: null, error: response.error };
  }

  return { ok: true, remembered: true, entity: mapEntity(response.data) };
}

/**
 * Archive a habit's behavioral memory (recoverable, not deleted). Used when a
 * habit is retired so its profile no longer pollutes recall/search. Safe no-op
 * when disabled; returns ok:true if there was simply nothing to archive.
 */
export async function archiveHabitMemory(
  userId: string,
  habitId: string,
  reason?: string,
): Promise<MemoryWriteResult> {
  if (!env.sibylEnabled) return disabledMeta();

  const args: Record<string, unknown> = { category: 'habit_behavior', name: habitId };
  if (reason) args.reason = reason;

  const response = await runSibylOp({
    op: 'archive_entity',
    tenantId: userId,
    args,
  });

  if (!response.ok) {
    if (response.error?.type === 'NotFoundError') {
      // Nothing to archive — treat as success.
      return notFoundMeta();
    }
    warn('archiveHabitMemory', response.error);
    return toMeta(response);
  }
  return okMeta();
}

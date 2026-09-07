import { randomUUID } from 'node:crypto';

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { computeUserAnalytics } from './analytics.js';
import {
  saveRecommendationOutcome,
  searchMemories,
  type MemoryEntity,
  type MemorySearchResult,
} from './memory.js';
import {
  interventionService,
  type InterventionRequest,
  type InterventionResult,
} from './virtuals.js';

const GEMINI_MODEL = 'gemini-3.6-flash';
const CONTEXT_LOOKBACK_DAYS = 30;

/** Max distinct per-habit queries issued per memory category. */
const MEMORY_QUERY_LIMIT = 5;
const MEMORY_LIMIT_HABIT_BEHAVIOR = 5;
const MEMORY_LIMIT_RECOMMENDATION = 3;

/**
 * The kinds of accountability action Gemini may ask for. Nothing here executes
 * anything — this is only the vocabulary the decision is expressed in.
 */
const INTERVENTION_KINDS = ['nudge', 'commitment_check', 'escalate'] as const;

const interventionDecisionSchema = z.object({
  needed: z.boolean(),
  kind: z.enum(INTERVENTION_KINDS),
  reason: z.string().min(1),
});

const geminiResponseSchema = z.object({
  message: z.string().min(1),
  recommendation: z.string().min(1),
  reason: z.string().min(1),
  memoryUsed: z.boolean(),
  // Optional + nullable: an older/smaller model reply that omits the field
  // entirely must still validate, so the recommendation path never breaks.
  intervention: interventionDecisionSchema.nullable().optional(),
});

export type AgentInterventionKind = (typeof INTERVENTION_KINDS)[number];

/** Gemini's intervention decision. Gemini is the only thing that produces it. */
export type AgentInterventionDecision = {
  needed: boolean;
  kind: AgentInterventionKind;
  reason: string;
};

export type AgentRecommendation = z.infer<typeof geminiResponseSchema>;

export interface AgentRecommendationResponse extends AgentRecommendation {
  generatedAt: string;
  /** Always present; `null` when Gemini decided no intervention is warranted. */
  intervention: AgentInterventionDecision | null;
}

export interface AgentContext {
  userId: string;
  generatedAt: string;
  factual: {
    activeHabits: Array<{
      id: string;
      name: string;
      frequency: string;
      target: number;
      preferredTime: string | null;
      status: string;
    }>;
    recentCompletions: Array<{
      habitId: string;
      date: string;
      status: string;
      missReason: string | null;
    }>;
    analytics: {
      overall: {
        completionRate: number;
        currentStreak: number;
        bestStreak: number;
        totalCompleted: number;
        totalMissed: number;
        totalTracked: number;
      };
      habits: Array<{
        habitId: string;
        name: string;
        completionRate: number;
        currentStreak: number;
        bestStreak: number;
        totalCompleted: number;
        totalMissed: number;
        totalTracked: number;
      }>;
      mostConsistentHabit: {
        habitId: string;
        name: string;
        completionRate: number;
      } | null;
      leastConsistentHabit: {
        habitId: string;
        name: string;
        completionRate: number;
      } | null;
      commonMissReasons: Array<{ reason: string; count: number }>;
      dateRange: { from: string | null; to: string | null };
    };
  };
  memory: {
    note: string;
    habitBehavior: Array<{
      name: string;
      body: unknown;
      updatedAt?: string;
    }>;
    priorRecommendations: Array<{
      name: string;
      body: unknown;
      updatedAt?: string;
    }>;
    memoryUsed: boolean;
  };
}

export type GenerateModelResponse = (input: {
  prompt: string;
  context: AgentContext;
}) => Promise<string>;

export interface AgentDependencies {
  loadActiveHabits: (userId: string) => Promise<Array<{
    id: string;
    name: string;
    frequency: string;
    target: number;
    preferredTime: string | null;
    status: string;
  }>>;
  loadRecentCompletions: (userId: string, fromDate: Date) => Promise<Array<{
    habitId: string;
    date: Date;
    status: string;
    missReason: string | null;
  }>>;
  computeAnalytics: typeof computeUserAnalytics;
  searchMemories: (userId: string, query: string, options?: { limit?: number; category?: string }) => Promise<MemorySearchResult>;
  saveRecommendationOutcome: typeof saveRecommendationOutcome;
  generateModelResponse: GenerateModelResponse;
  now: () => Date;
  randomId: () => string;
  /**
   * Executes an already-decided intervention. The agent only ever CALLS this
   * when Gemini's decision says `needed`; it never inspects habits, analytics,
   * or memories to decide. Defaults to the Virtuals action-layer singleton.
   */
  requestIntervention: (request: InterventionRequest) => Promise<InterventionResult>;
}

export class AgentServiceError extends Error {
  constructor(
    public readonly code:
      | 'GEMINI_NOT_CONFIGURED'
      | 'GEMINI_REQUEST_FAILED'
      | 'MALFORMED_MODEL_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'AgentServiceError';
  }
}

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!env.geminiApiKey) {
    throw new AgentServiceError(
      'GEMINI_NOT_CONFIGURED',
      'GEMINI_API_KEY is not configured.',
    );
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }
  return geminiClient;
}

function extractGeminiText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';

  const direct = (response as { text?: unknown }).text;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  const candidates = (response as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; thought?: boolean }>;
      };
    }>;
  }).candidates;

  if (!Array.isArray(candidates)) return '';

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';

  const text = parts
    .filter((part) => !part?.thought && typeof part?.text === 'string')
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();

  return text;
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // continue
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Normalise free text into a safe Sibyl FTS query.
 *
 * Sibyl's `search_entities` runs an FTS match over the stored entity body, and
 * it requires EVERY term to appear in the SAME document (AND semantics). Two
 * consequences drive this design:
 *
 *  1. A query built from several different habit names at once ("Study Gym")
 *     matches nothing, because no single entity contains all of them. So we
 *     issue one query per habit and merge the results instead.
 *  2. Generic words that are never written into the body ("habit", "behavior",
 *     "accountability") also match nothing — the previous hardcoded query
 *     `'habit behavior accountability'` always returned zero hits.
 *
 * Punctuation is stripped to spaces: quotes, parentheses and other FTS operators
 * in a habit name would otherwise be parsed as query syntax. Letters/digits are
 * kept Unicode-aware so non-ASCII habit names still work.
 */
function toSearchQuery(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One deduped, sanitised query per active habit, capped at MEMORY_QUERY_LIMIT. */
function buildMemoryQueries(habits: Array<{ name: string }>): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];

  for (const habit of habits) {
    const query = toSearchQuery(habit.name ?? '');
    if (!query) continue;

    const key = query.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    queries.push(query);

    if (queries.length >= MEMORY_QUERY_LIMIT) break;
  }

  return queries;
}

function compactMemoryItems(items: MemoryEntity[]) {
  return items.map((item) => ({
    name: item.name,
    body: item.body,
    updatedAt: item.updatedAt,
  }));
}

function buildPrompt(context: AgentContext): string {
  const contextJson = JSON.stringify(context, null, 2);
  return [
    'You are Habitra accountability assistant.',
    'CRITICAL RULES:',
    '- PostgreSQL factual data is source-of-truth.',
    '- Sibyl memories are behavioral/contextual hints and may be incomplete or stale.',
    '- Do not invent user history, habits, streaks, misses, or outcomes.',
    '- Make recommendations only from the supplied context.',
    '- Never expose secrets, credentials, API keys, JWTs, cookies, or internal configuration.',
    '- Keep output concise and practical.',
    'INTERVENTION RULES (you are the only decision-maker for these):',
    '- An intervention is outreach outside the app. Set intervention to null unless it would genuinely change the outcome.',
    '- Consider one only for: repeated recent misses, a broken streak, or an active commitment at risk.',
    '- Do not repeat an intervention already recorded in priorRecommendations for the same reason.',
    '- kind: nudge = gentle reminder; commitment_check = verify an active commitment; escalate = stronger accountability step.',
    '- reason must say why now, in one sentence.',
    'Return ONLY valid JSON matching this exact schema:',
    '{"message": string, "recommendation": string, "reason": string, "memoryUsed": boolean, "intervention": null | {"needed": boolean, "kind": "nudge" | "commitment_check" | "escalate", "reason": string}}',
    'Context follows:',
    contextJson,
  ].join('\n');
}

const defaultDependencies: AgentDependencies = {
  loadActiveHabits: (userId) => prisma.habit.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      name: true,
      frequency: true,
      target: true,
      preferredTime: true,
      status: true,
    },
  }),
  loadRecentCompletions: (userId, fromDate) => prisma.habitCompletion.findMany({
    where: { userId, date: { gte: fromDate } },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: 60,
    select: {
      habitId: true,
      date: true,
      status: true,
      missReason: true,
    },
  }),
  computeAnalytics: computeUserAnalytics,
  searchMemories,
  saveRecommendationOutcome,
  requestIntervention: (request) => interventionService.requestIntervention(request),
  generateModelResponse: async ({ prompt }) => {
    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });

    return extractGeminiText(response);
  },
  now: () => new Date(),
  randomId: () => randomUUID(),
};

/**
 * Dependencies required to assemble an {@link AgentContext}.
 *
 * Deliberately narrower than {@link AgentDependencies}: building context must
 * not require — or be able to trigger — a model call or a memory write. That is
 * what lets a future background job reuse this context builder without going
 * through recommendation generation.
 */
export type AgentContextDependencies = Pick<
  AgentDependencies,
  'loadActiveHabits' | 'loadRecentCompletions' | 'computeAnalytics' | 'searchMemories' | 'now'
>;

/**
 * Runs one Sibyl FTS query per habit name and merges the hits.
 *
 * See {@link toSearchQuery} for why the queries cannot be combined. A rejected
 * query is treated as "no hits" so one failing habit name cannot break the
 * whole context.
 */
async function searchMemoriesAcrossQueries(
  deps: AgentContextDependencies,
  userId: string,
  activeHabits: Array<{ name: string }>,
  category: string,
  limit: number,
): Promise<{ ok: boolean; items: MemoryEntity[] }> {
  const queries = buildMemoryQueries(activeHabits);

  if (queries.length === 0) {
    return { ok: true, items: [] };
  }

  const results = await Promise.all(
    queries.map((query) =>
      deps.searchMemories(userId, query, { category, limit }).catch(() => null),
    ),
  );

  const seen = new Set<string>();
  const items: MemoryEntity[] = [];
  let ok = false;

  for (const result of results) {
    if (!result) continue;
    if (result.ok) ok = true;

    for (const item of result.items) {
      const key = `${item.category}::${item.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  return { ok, items };
}

/**
 * Builds the full {@link AgentContext} for one user: PostgreSQL facts plus
 * Sibyl behavioural memories.
 *
 * Purely a read path — it never calls the model and never writes memory. The
 * `userId` must be the authenticated id from `requireAuth`, never a
 * client-supplied value, so tenant isolation holds.
 */
export async function buildAgentContext(
  userId: string,
  deps: AgentContextDependencies,
): Promise<AgentContext> {
  const now = deps.now();
  const from = new Date(now.getTime() - CONTEXT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [activeHabits, recentCompletions, analytics] = await Promise.all([
    deps.loadActiveHabits(userId),
    deps.loadRecentCompletions(userId, from),
    deps.computeAnalytics(userId, { from: toIsoDay(from), to: toIsoDay(now) }),
  ]);

  // Memory retrieval depends on the habit names above, so it runs in a
  // second wave.
  const [habitBehaviorMemories, recommendationMemories] = await Promise.all([
    searchMemoriesAcrossQueries(deps, userId, activeHabits, 'habit_behavior', MEMORY_LIMIT_HABIT_BEHAVIOR),
    searchMemoriesAcrossQueries(deps, userId, activeHabits, 'recommendation', MEMORY_LIMIT_RECOMMENDATION),
  ]);

  const memoryItems = [
    ...(habitBehaviorMemories.ok ? habitBehaviorMemories.items : []),
    ...(recommendationMemories.ok ? recommendationMemories.items : []),
  ];

  return {
    userId,
    generatedAt: now.toISOString(),
    factual: {
      activeHabits,
      recentCompletions: recentCompletions.map((entry) => ({
        habitId: entry.habitId,
        date: toIsoDay(entry.date),
        status: entry.status,
        missReason: entry.missReason,
      })),
      analytics: {
        overall: analytics.overall,
        habits: analytics.habits,
        mostConsistentHabit: analytics.mostConsistentHabit
          ? {
            habitId: analytics.mostConsistentHabit.habitId,
            name: analytics.mostConsistentHabit.name,
            completionRate: analytics.mostConsistentHabit.completionRate,
          }
          : null,
        leastConsistentHabit: analytics.leastConsistentHabit
          ? {
            habitId: analytics.leastConsistentHabit.habitId,
            name: analytics.leastConsistentHabit.name,
            completionRate: analytics.leastConsistentHabit.completionRate,
          }
          : null,
        commonMissReasons: analytics.commonMissReasons,
        dateRange: analytics.dateRange,
      },
    },
    memory: {
      note: 'Sibyl memory is contextual and may be incomplete or stale.',
      habitBehavior: compactMemoryItems(habitBehaviorMemories.ok ? habitBehaviorMemories.items : []),
      priorRecommendations: compactMemoryItems(recommendationMemories.ok ? recommendationMemories.items : []),
      memoryUsed: memoryItems.length > 0,
    },
  };
}

export function createAccountabilityAgentService(overrides: Partial<AgentDependencies> = {}) {
  const deps: AgentDependencies = { ...defaultDependencies, ...overrides };

  return {
    async generateRecommendation(userId: string): Promise<AgentRecommendationResponse> {
      const context = await buildAgentContext(userId, deps);

      const prompt = buildPrompt(context);

      let raw: string;
      try {
        raw = await deps.generateModelResponse({ prompt, context });
      } catch (err) {
        throw new AgentServiceError(
          'GEMINI_REQUEST_FAILED',
          `Gemini request failed: ${(err as Error)?.message ?? String(err)}`,
        );
      }

      const parsed = parseJsonObject(raw);
      const validated = geminiResponseSchema.safeParse(parsed);
      if (!validated.success) {
        throw new AgentServiceError(
          'MALFORMED_MODEL_OUTPUT',
          'Gemini returned malformed recommendation output.',
        );
      }

      const response: AgentRecommendationResponse = {
        ...validated.data,
        // Same instant the context was built with: recommendation and its
        // supporting context must never drift apart.
        generatedAt: context.generatedAt,
        // Gemini may omit the field entirely; callers should never have to
        // distinguish "omitted" from "decided not to intervene".
        intervention: validated.data.intervention ?? null,
      };

      const recommendationId = deps.randomId();
      void deps
        .saveRecommendationOutcome(userId, {
          recommendationId,
          text: `${response.recommendation}\nReason: ${response.reason}`,
          helpful: null,
          accepted: null,
          source: 'agent_recommendation_v1',
        })
        .then((writeResult) => {
          if (!writeResult.ok) {
            console.warn('[agent] recommendation memory write failed');
          }
        })
        .catch(() => {
          console.warn('[agent] recommendation memory write threw unexpectedly');
        });

      // Gemini is the only decision-maker. We act ONLY when its decision says
      // needed. The action layer never re-decides; it just executes. Fire and
      // forget: an intervention outage must not delay or break the response.
      const decision = response.intervention;
      if (decision && decision.needed) {
        const analytics = context.factual.analytics;
        const misses = context.factual.recentCompletions.filter(
          (entry) => entry.status === 'MISSED',
        ).length;
        const habitName =
          analytics.leastConsistentHabit?.name
          ?? analytics.mostConsistentHabit?.name
          ?? context.factual.activeHabits[0]?.name
          ?? undefined;

        const interventionRequest: InterventionRequest = {
          userId,
          interventionId: deps.randomId(),
          kind: decision.kind,
          habitId: null,
          challengeId: null,
          goal: response.recommendation,
          message: response.message,
          reason: decision.reason,
          context: {
            habitName,
            currentStreak: analytics.overall.currentStreak,
            completionRate: analytics.overall.completionRate,
            missedLastDays: misses,
          },
          requestedAt: context.generatedAt,
        };

        void deps.requestIntervention(interventionRequest).catch((err) => {
          console.warn('[agent] intervention dispatch failed:', (err as Error)?.message ?? String(err));
        });
      }

      return response;
    },
  };
}

export const accountabilityAgentService = createAccountabilityAgentService();
export const geminiModelName = GEMINI_MODEL;

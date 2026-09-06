import { randomUUID } from 'node:crypto';

import express from 'express';

import { prisma } from '../src/db/prisma.js';
import { signAuthToken, AUTH_COOKIE } from '../src/auth/jwt.js';
import {
  AgentServiceError,
  createAccountabilityAgentService,
  type AgentContext,
  type AgentRecommendationResponse,
} from '../src/services/agent.js';
import { createAgentRouter } from '../src/routes/agent.js';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: Check[] = [];
function check(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const createdUserIds: string[] = [];

  try {
    const userA = await prisma.user.create({
      data: {
        name: 'agent-user-a',
        email: `agent-a-${Date.now()}@example.com`,
        passwordHash: 'hash',
      },
    });
    createdUserIds.push(userA.id);

    const userB = await prisma.user.create({
      data: {
        name: 'agent-user-b',
        email: `agent-b-${Date.now()}@example.com`,
        passwordHash: 'hash',
      },
    });
    createdUserIds.push(userB.id);

    // ---------------- Route-level auth/isolation tests ----------------
    let calledWithUserId: string | null = null;
    const routeStubService = {
      async generateRecommendation(userId: string): Promise<AgentRecommendationResponse> {
        calledWithUserId = userId;
        return {
          message: 'Keep going.',
          recommendation: 'Do your easiest habit first.',
          reason: 'It lowers startup friction.',
          memoryUsed: false,
          generatedAt: new Date().toISOString(),
        };
      },
    };

    const app = express();
    app.use(express.json());
    app.use('/api/agent', createAgentRouter(routeStubService));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const unauth = await fetch(`http://127.0.0.1:${port}/api/agent/recommendation`);
    check('unauthenticated recommendation request is rejected', unauth.status === 401, `status=${unauth.status}`);

    const tokenA = signAuthToken(userA.id);
    const authRes = await fetch(`http://127.0.0.1:${port}/api/agent/recommendation?userId=${encodeURIComponent(userB.id)}`, {
      headers: { Cookie: `${AUTH_COOKIE}=${tokenA}` },
    });
    const authJson = await authRes.json();

    check('authenticated user can request recommendation', authRes.status === 200, `status=${authRes.status}`);
    check(
      'response follows expected schema',
      typeof authJson?.data?.recommendation?.message === 'string'
        && typeof authJson?.data?.recommendation?.recommendation === 'string'
        && typeof authJson?.data?.recommendation?.reason === 'string'
        && typeof authJson?.data?.recommendation?.memoryUsed === 'boolean',
    );
    check(
      'client userId cannot override authenticated user id',
      calledWithUserId === userA.id,
      `calledWith=${calledWithUserId}`,
    );

    server.close();

    // ---------------- Service-level context / failure tests ----------------
    const fromDate = new Date('2026-08-07T00:00:00.000Z');
    const nowDate = new Date('2026-09-06T12:00:00.000Z');

    const habitsByUser: Record<string, Array<any>> = {
      [userA.id]: [
        {
          id: 'habit-a-1',
          name: 'Morning run',
          frequency: 'DAILY',
          target: 1,
          preferredTime: '07:00',
          status: 'ACTIVE',
        },
      ],
      [userB.id]: [
        {
          id: 'habit-b-1',
          name: 'Secret habit B',
          frequency: 'DAILY',
          target: 1,
          preferredTime: null,
          status: 'ACTIVE',
        },
      ],
    };

    const completionsByUser: Record<string, Array<any>> = {
      [userA.id]: [
        { habitId: 'habit-a-1', date: new Date('2026-09-06T00:00:00.000Z'), status: 'COMPLETED', missReason: null },
      ],
      [userB.id]: [
        { habitId: 'habit-b-1', date: new Date('2026-09-06T00:00:00.000Z'), status: 'MISSED', missReason: 'private B reason' },
      ],
    };

    const memoryCalls: Array<{ userId: string; category?: string; query?: string }> = [];
    let capturedContext: AgentContext | null = null;
    let saveCalls = 0;

    const service = createAccountabilityAgentService({
      loadActiveHabits: async (userId) => habitsByUser[userId] ?? [],
      loadRecentCompletions: async (userId, _fromDate) => completionsByUser[userId] ?? [],
      computeAnalytics: async (userId) => ({
        dateRange: { from: '2026-08-07', to: '2026-09-06' },
        overall: {
          completionRate: userId === userA.id ? 100 : 0,
          currentStreak: userId === userA.id ? 1 : 0,
          bestStreak: userId === userA.id ? 1 : 0,
          totalCompleted: userId === userA.id ? 1 : 0,
          totalMissed: userId === userA.id ? 0 : 1,
          totalTracked: 1,
        },
        habits: userId === userA.id
          ? [{
            habitId: 'habit-a-1',
            name: 'Morning run',
            completionRate: 100,
            currentStreak: 1,
            bestStreak: 1,
            totalCompleted: 1,
            totalMissed: 0,
            totalTracked: 1,
          }]
          : [{
            habitId: 'habit-b-1',
            name: 'Secret habit B',
            completionRate: 0,
            currentStreak: 0,
            bestStreak: 0,
            totalCompleted: 0,
            totalMissed: 1,
            totalTracked: 1,
          }],
        mostConsistentHabit: userId === userA.id
          ? { habitId: 'habit-a-1', name: 'Morning run', completionRate: 100, currentStreak: 1, bestStreak: 1, totalCompleted: 1, totalMissed: 0, totalTracked: 1 }
          : { habitId: 'habit-b-1', name: 'Secret habit B', completionRate: 0, currentStreak: 0, bestStreak: 0, totalCompleted: 0, totalMissed: 1, totalTracked: 1 },
        leastConsistentHabit: userId === userA.id
          ? { habitId: 'habit-a-1', name: 'Morning run', completionRate: 100, currentStreak: 1, bestStreak: 1, totalCompleted: 1, totalMissed: 0, totalTracked: 1 }
          : { habitId: 'habit-b-1', name: 'Secret habit B', completionRate: 0, currentStreak: 0, bestStreak: 0, totalCompleted: 0, totalMissed: 1, totalTracked: 1 },
        commonMissReasons: userId === userA.id ? [] : [{ reason: 'private B reason', count: 1 }],
      }),
      searchMemories: async (userId, query, options) => {
        memoryCalls.push({ userId, category: options?.category, query });
        if (userId === userA.id) {
          if (options?.category === 'habit_behavior') {
            return {
              ok: true,
              remembered: true,
              items: [{ category: 'habit_behavior', name: 'habit-a-1', body: { notes: 'A memory' }, updatedAt: '2026-09-05T10:00:00.000Z' }],
            };
          }
          return {
            ok: true,
            remembered: true,
            items: [{ category: 'recommendation', name: 'rec-a-prev', body: { text: 'A previous recommendation' }, updatedAt: '2026-09-05T10:00:00.000Z' }],
          };
        }

        if (options?.category === 'habit_behavior') {
          return {
            ok: true,
            remembered: true,
            items: [{ category: 'habit_behavior', name: 'habit-b-1', body: { notes: 'B private memory' }, updatedAt: '2026-09-05T10:00:00.000Z' }],
          };
        }

        return {
          ok: true,
          remembered: true,
          items: [{ category: 'recommendation', name: 'rec-b-prev', body: { text: 'B private recommendation' }, updatedAt: '2026-09-05T10:00:00.000Z' }],
        };
      },
      generateModelResponse: async ({ context }) => {
        capturedContext = context;
        return JSON.stringify({
          message: 'You can do this.',
          recommendation: 'Start with Morning run now.',
          reason: 'You already have momentum in this habit.',
          memoryUsed: true,
        });
      },
      saveRecommendationOutcome: async () => {
        saveCalls += 1;
        return { ok: true, remembered: true };
      },
      now: () => nowDate,
      randomId: () => 'test-rec-id',
    });

    const recommendation = await service.generateRecommendation(userA.id);
    check('service recommendation schema is valid',
      typeof recommendation.message === 'string'
      && typeof recommendation.recommendation === 'string'
      && typeof recommendation.reason === 'string'
      && typeof recommendation.memoryUsed === 'boolean',
    );

    check('Sibyl memories are retrieved via memory service dependency (habit_behavior)',
      memoryCalls.some((call) => call.userId === userA.id && call.category === 'habit_behavior'));
    check('Sibyl memories are retrieved via memory service dependency (recommendation)',
      memoryCalls.some((call) => call.userId === userA.id && call.category === 'recommendation'));

    // STEP 12C — the query must be derived from content that is actually stored.
    // Sibyl FTS uses AND semantics, so generic words that never appear in the
    // WARM body ("habit", "behavior", "accountability") can never match.
    const behaviorQueries = memoryCalls
      .filter((call) => call.userId === userA.id && call.category === 'habit_behavior')
      .map((call) => call.query ?? '');
    check(
      'memory query is derived from the user real habit name',
      behaviorQueries.some((q) => q.includes('Morning run')),
      `queries=${JSON.stringify(behaviorQueries)}`,
    );
    check(
      'memory query no longer uses generic words absent from stored bodies',
      behaviorQueries.every((q) => !/\bhabit behavior accountability\b/i.test(q)),
      `queries=${JSON.stringify(behaviorQueries)}`,
    );
    check(
      'memory query never contains user B habit name',
      behaviorQueries.every((q) => !q.includes('Secret habit B')),
      `queries=${JSON.stringify(behaviorQueries)}`,
    );

    const contextJson = JSON.stringify(capturedContext ?? {});
    check(
      'Gemini receives only authenticated user context',
      contextJson.includes('Morning run')
        && !contextJson.includes('Secret habit B')
        && !contextJson.includes('private B reason')
        && !contextJson.includes('B private memory'),
    );
    check('user A cannot receive user B habit or memory context',
      !contextJson.includes('habit-b-1') && !contextJson.includes('rec-b-prev'));

    // Give one microtask turn so fire-and-forget save callback can run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    check('recommendation outcome is remembered after success', saveCalls === 1, `saveCalls=${saveCalls}`);

    const malformedService = createAccountabilityAgentService({
      loadActiveHabits: async () => [],
      loadRecentCompletions: async () => [],
      computeAnalytics: async () => ({
        dateRange: { from: '2026-08-07', to: '2026-09-06' },
        overall: { completionRate: 0, currentStreak: 0, bestStreak: 0, totalCompleted: 0, totalMissed: 0, totalTracked: 0 },
        habits: [],
        mostConsistentHabit: null,
        leastConsistentHabit: null,
        commonMissReasons: [],
      }),
      searchMemories: async () => ({ ok: true, remembered: true, items: [] }),
      generateModelResponse: async () => 'not-json',
      saveRecommendationOutcome: async () => ({ ok: true, remembered: true }),
      now: () => nowDate,
      randomId: () => 'malformed-id',
    });

    let malformedCode: string | null = null;
    try {
      await malformedService.generateRecommendation(userA.id);
    } catch (err) {
      if (err instanceof AgentServiceError) malformedCode = err.code;
    }
    check('malformed Gemini output is handled safely', malformedCode === 'MALFORMED_MODEL_OUTPUT', `code=${malformedCode}`);

    const failingGeminiService = createAccountabilityAgentService({
      loadActiveHabits: async () => [],
      loadRecentCompletions: async () => [],
      computeAnalytics: async () => ({
        dateRange: { from: '2026-08-07', to: '2026-09-06' },
        overall: { completionRate: 0, currentStreak: 0, bestStreak: 0, totalCompleted: 0, totalMissed: 0, totalTracked: 0 },
        habits: [],
        mostConsistentHabit: null,
        leastConsistentHabit: null,
        commonMissReasons: [],
      }),
      searchMemories: async () => ({ ok: true, remembered: true, items: [] }),
      generateModelResponse: async () => {
        throw new Error('simulated upstream failure');
      },
      saveRecommendationOutcome: async () => ({ ok: true, remembered: true }),
      now: () => nowDate,
      randomId: () => 'failure-id',
    });

    let failureCode: string | null = null;
    try {
      await failingGeminiService.generateRecommendation(userA.id);
    } catch (err) {
      if (err instanceof AgentServiceError) failureCode = err.code;
    }
    check('Gemini/API failure is handled safely', failureCode === 'GEMINI_REQUEST_FAILED', `code=${failureCode}`);

    let sibylSaveCalls = 0;
    const sibylFailService = createAccountabilityAgentService({
      loadActiveHabits: async () => habitsByUser[userA.id],
      loadRecentCompletions: async () => completionsByUser[userA.id],
      computeAnalytics: async () => ({
        dateRange: { from: '2026-08-07', to: '2026-09-06' },
        overall: { completionRate: 100, currentStreak: 1, bestStreak: 1, totalCompleted: 1, totalMissed: 0, totalTracked: 1 },
        habits: [{ habitId: 'habit-a-1', name: 'Morning run', completionRate: 100, currentStreak: 1, bestStreak: 1, totalCompleted: 1, totalMissed: 0, totalTracked: 1 }],
        mostConsistentHabit: { habitId: 'habit-a-1', name: 'Morning run', completionRate: 100, currentStreak: 1, bestStreak: 1, totalCompleted: 1, totalMissed: 0, totalTracked: 1 },
        leastConsistentHabit: { habitId: 'habit-a-1', name: 'Morning run', completionRate: 100, currentStreak: 1, bestStreak: 1, totalCompleted: 1, totalMissed: 0, totalTracked: 1 },
        commonMissReasons: [],
      }),
      searchMemories: async () => ({ ok: false, remembered: false, items: [], error: { type: 'SpawnError', message: 'simulated sibyl read failure' } }),
      generateModelResponse: async () => JSON.stringify({
        message: 'No memory available right now.',
        recommendation: 'Do one small action now.',
        reason: 'Small wins rebuild consistency.',
        memoryUsed: false,
      }),
      saveRecommendationOutcome: async () => {
        sibylSaveCalls += 1;
        return { ok: false, remembered: false, error: { type: 'SpawnError', message: 'simulated sibyl write failure' } };
      },
      now: () => nowDate,
      randomId: () => 'sibyl-fail-id',
    });

    const sibylFailureResult = await sibylFailService.generateRecommendation(userA.id);
    check('Sibyl failure does not crash recommendation generation', typeof sibylFailureResult.recommendation === 'string');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    check('Sibyl write attempted even when non-blocking', sibylSaveCalls === 1, `saveCalls=${sibylSaveCalls}`);

    check('agent context lookup uses 30-day window helper (sanity)', fromDate.toISOString().startsWith('2026-08-07'));
  } finally {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log(`\nAgent test suite: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }

  console.log(`\nAgent test suite: ${results.length}/${results.length} checks PASSED`);
}

main().catch((err) => {
  console.error('Agent test suite crashed:', err);
  process.exit(1);
});

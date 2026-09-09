/**
 * learning_loop_scenario.ts — one Sibyl learning-loop scenario per process.
 *
 * Spawned by learning_loop_test.ts with an isolated SIBYL_DB_PATH and
 * SIBYL_ENABLED. Because env.ts is evaluated at import time, a fresh process per
 * scenario gives each a clean config — required to exercise disabled mode without
 * polluting shared state.
 *
 * This scenario drives the REAL memory layer (real Sibyl bridge) so the tests
 * genuinely prove "the outcome is stored in Sibyl" and "a later recommendation
 * can retrieve the outcome memory". Only the model and the Postgres/fact loaders
 * are stubbed — the learning behavior under test goes through the real bridge.
 *
 * Reads SIBYL_SCENARIO to pick the scenario, prints PASS/FAIL lines, exits 0 only
 * if every check passed.
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // scripts/tests -> backend
const venvPython =
  process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
const bridgeScript = path.join(backendRoot, 'scripts', 'sibyl_bridge.py');

// Set before importing memory.ts / agent.ts, which read env at import time.
process.env.SIBYL_ENABLED = process.env.SIBYL_ENABLED ?? 'true';
process.env.SIBYL_PYTHON = process.env.SIBYL_PYTHON ?? venvPython;
process.env.SIBYL_BRIDGE_SCRIPT = process.env.SIBYL_BRIDGE_SCRIPT ?? bridgeScript;
process.env.SIBYL_DB_PATH =
  process.env.SIBYL_DB_PATH ??
  path.join(os.tmpdir(), `sibyl-loop-${process.env.SIBYL_SCENARIO}-${Date.now()}.db`);

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: Check[] = [];
function check(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}

// Deterministic analytics stub shape the agent context builder consumes.
function analyticsStub() {
  return {
    dateRange: { from: '2026-08-07', to: '2026-09-06' },
    overall: { completionRate: 0, currentStreak: 0, bestStreak: 0, totalCompleted: 0, totalMissed: 1, totalTracked: 1 },
    habits: [],
    mostConsistentHabit: null,
    leastConsistentHabit: null,
    commonMissReasons: [{ reason: 'tired in the morning', count: 1 }],
  };
}

async function main(): Promise<void> {
  const scenario = process.env.SIBYL_SCENARIO;
  const mem = await import('../../src/services/memory.js');
  const agent = await import('../../src/services/agent.js');

  /**
   * Poll recallEntity until the entity appears (or a timeout elapses). The agent's
   * initial outcome write is intentionally fire-and-forget (failure-safe), so a
   * caller may observe the recommendation response before the SQLite write lands.
   * Polling removes the timing race without changing the production design.
   */
  async function waitForEntity(
    userId: string,
    category: string,
    name: string,
    timeoutMs = 8000,
  ): Promise<Awaited<ReturnType<typeof mem.recallEntity>>> {
    const start = Date.now();
    let last = await mem.recallEntity(userId, category, name);
    while (Date.now() - start < timeoutMs && !(last.ok && last.entity)) {
      await new Promise<void>((r) => setTimeout(r, 100));
      last = await mem.recallEntity(userId, category, name);
    }
    return last;
  }

  if (scenario === 'learning_loop') {
    const userId = 'loop-user';
    const habitId = 'h-morning';
    const habitName = 'Morning Reading';

    // ---- 1. Record behavioral memory (misses because tired in the morning) ----
    const profile = await mem.saveHabitBehaviorProfile(userId, habitId, {
      habitId,
      habitName,
      bestTimeOfDay: 'morning',
      commonMissReasons: ['tired in the morning'],
      notes: 'Repeatedly misses Morning Reading because they are tired in the morning.',
    });
    check('behavioral memory can be written (saveHabitBehaviorProfile)', profile.ok && !profile.disabled, `ok=${profile.ok} disabled=${profile.disabled}`);

    const ev1 = await mem.recordCompletionEvent(userId, {
      habitId,
      habitName,
      outcome: 'missed',
      date: '2026-09-01',
      missReason: 'tired in the morning',
    });
    const ev2 = await mem.recordCompletionEvent(userId, {
      habitId,
      habitName,
      outcome: 'missed',
      date: '2026-09-02',
      missReason: 'tired in the morning',
    });
    check('behavioral event memories can be written', ev1.ok && ev2.ok, `ev1=${ev1.ok} ev2=${ev2.ok}`);

    // ---- Agent setup: real memory layer, stubbed model + fact loaders ----
    let n = 0;
    let capturedContext: unknown = null;
    let capturedPrompt = '';
    const fixedModelReply = JSON.stringify({
      message: 'Lets adjust the time.',
      recommendation: 'Move Morning Reading to 7 PM so you are not fighting morning fatigue.',
      reason: 'You consistently miss it in the morning due to fatigue.',
      memoryUsed: true,
    });

    const service = agent.createAccountabilityAgentService({
      loadActiveHabits: async () => [
        { id: habitId, name: habitName, frequency: 'DAILY', target: 1, preferredTime: '07:00', status: 'ACTIVE' },
      ],
      loadRecentCompletions: async () => [
        { habitId, date: new Date('2026-09-06T00:00:00.000Z'), status: 'MISSED', missReason: 'tired in the morning' },
      ],
      computeAnalytics: async () => analyticsStub(),
      generateModelResponse: async ({ prompt, context }) => {
        capturedPrompt = prompt;
        capturedContext = context;
        return fixedModelReply;
      },
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      randomId: () => `rec-${(++n).toString()}`,
    });

    // ---- 2. First recommendation: agent retrieves the behavior memory ----
    const rec1 = await service.generateRecommendation(userId);
    await new Promise<void>((r) => setTimeout(r, 10)); // let fire-and-forget save complete

    check('first recommendation carries a stable recommendationId', typeof rec1.recommendationId === 'string' && rec1.recommendationId.length > 0, `id=${rec1.recommendationId}`);

    const ctx1 = capturedContext as { memory?: { habitBehavior?: Array<{ name: string; body: unknown }> } };
    const behaviorPresent = (ctx1?.memory?.habitBehavior ?? []).some(
      (m) => m.name === habitId && JSON.stringify(m.body).includes('tired in the morning'),
    );
    check('agent retrieves behavioral memory into its context (req 2)', behaviorPresent);

    // The initial auto-saved outcome must be UNKNOWN (null/null), never success.
    const initialOutcome = await waitForEntity(userId, 'recommendation', rec1.recommendationId);
    const initialBody = initialOutcome.entity?.body as { accepted?: boolean | null; helpful?: boolean | null } | null;
    check(
      'initial recommendation outcome is stored as unknown (null/null), not success (req 9)',
      initialOutcome.ok && initialBody?.accepted === null && initialBody?.helpful === null,
      `accepted=${initialBody?.accepted} helpful=${initialBody?.helpful}`,
    );

    // ---- 3 + 4. Record accepted + helpful outcome; verify it is stored in Sibyl ----
    const recorded = await mem.recordRecommendationOutcome(userId, rec1.recommendationId, {
      accepted: true,
      helpful: true,
    });
    check('recommendation outcome can be recorded', recorded.ok && !recorded.disabled, `ok=${recorded.ok} disabled=${recorded.disabled}`);

    const stored = await mem.recallEntity(userId, 'recommendation', rec1.recommendationId);
    const storedBody = stored.entity?.body as { accepted?: boolean | null; helpful?: boolean | null; text?: string } | null;
    check('outcome is stored in Sibyl with accepted=true/helpful=true (req 4, 7)', stored.ok && storedBody?.accepted === true && storedBody?.helpful === true, `accepted=${storedBody?.accepted} helpful=${storedBody?.helpful}`);
    check('stored outcome preserves the recommendation text', !!storedBody?.text && storedBody.text.includes('Move Morning Reading to 7 PM'), `text=${storedBody?.text?.slice(0, 40)}`);

    // ---- 5 + 6. Later recommendation retrieves the prior outcome memory ----
    const rec2 = await service.generateRecommendation(userId);
    await new Promise<void>((r) => setTimeout(r, 10));

    const ctx2 = capturedContext as {
      memory?: { priorRecommendations?: Array<{ name: string; body: unknown }> };
    };
    const prior = (ctx2?.memory?.priorRecommendations ?? []).find((m) => {
      const b = m.body as { accepted?: boolean | null; helpful?: boolean | null; text?: string };
      return b?.accepted === true && b?.helpful === true && typeof b.text === 'string' && b.text.includes('Move Morning Reading to 7 PM');
    });
    check('a later recommendation retrieves the prior outcome memory (req 5)', !!prior, `priorCount=${(ctx2?.memory?.priorRecommendations ?? []).length}`);
    check('the later recommendation context contains the relevant prior outcome (req 6)', !!prior);
    check(
      'prior outcome appears in the prompt sent to the model',
      capturedPrompt.includes('Move Morning Reading to 7 PM') && capturedPrompt.includes('accepted'),
      `promptHasText=${capturedPrompt.includes('Move Morning Reading')} promptHasAccepted=${capturedPrompt.includes('accepted')}`,
    );

    // ---- 8. Declined / not-helpful representations ----
    const recordedDeclined = await mem.recordRecommendationOutcome(userId, `rec-declined`, {
      accepted: false,
      helpful: false,
    });
    check('declined outcome can be recorded', recordedDeclined.ok, `ok=${recordedDeclined.ok}`);
    const declined = await mem.recallEntity(userId, 'recommendation', 'rec-declined');
    const declinedBody = declined.entity?.body as { accepted?: boolean | null; helpful?: boolean | null };
    check('declined/ not-helpful represented correctly (req 8)', declinedBody?.accepted === false && declinedBody?.helpful === false, `accepted=${declinedBody?.accepted} helpful=${declinedBody?.helpful}`);

    // ---- 9. Unknown outcome is NOT treated as success ----
    const recordedUnknown = await mem.recordRecommendationOutcome(userId, `rec-unknown`, {
      accepted: null,
      helpful: null,
    });
    check('unknown outcome can be recorded', recordedUnknown.ok);
    const unknown = await mem.recallEntity(userId, 'recommendation', 'rec-unknown');
    const unknownBody = unknown.entity?.body as { accepted?: boolean | null; helpful?: boolean | null };
    check('unknown outcome stays null (not silently success) (req 9)', unknownBody?.accepted === null && unknownBody?.helpful === null, `accepted=${unknownBody?.accepted} helpful=${unknownBody?.helpful}`);
    check('unknown outcome is not equal to accepted=true', !Object.is(unknownBody?.accepted, true));

    // ---- 10. Tenant isolation ----
    const otherUser = 'loop-user-B';
    await mem.recordRecommendationOutcome(otherUser, 'rec-other', { accepted: true, helpful: true });
    const aRecallOther = await mem.recallEntity(userId, 'recommendation', 'rec-other');
    check('user cannot recall another tenant recommendation (null, no error)', aRecallOther.ok && aRecallOther.entity === null, `entity=${aRecallOther.entity}`);
    const aSearchOther = await mem.searchMemories(userId, 'Morning');
    check('user search does not leak another tenant memory', aSearchOther.ok && !aSearchOther.items.some((i) => i.name === 'rec-other'), `leaked=${aSearchOther.items.some((i) => i.name === 'rec-other')}`);
    const bRecallOwn = await mem.recallEntity(otherUser, 'recommendation', 'rec-other');
    check('other tenant can read its own memory', bRecallOwn.ok && bRecallOwn.entity?.name === 'rec-other');

    return;
  }

  if (scenario === 'learning_loop_disabled') {
    check('SIBYL_ENABLED is false', process.env.SIBYL_ENABLED === 'false');

    const userId = 'loop-disabled-user';
    const habitId = 'h-morning';
    const habitName = 'Morning Reading';

    // With Sibyl off, writes and reads are safe no-ops.
    const w = await mem.saveHabitBehaviorProfile(userId, habitId, { habitId, habitName });
    check('write is a safe no-op (disabled)', w.ok === true && w.disabled === true);
    const s = await mem.searchMemories(userId, 'Morning Reading');
    check('search is a safe no-op (disabled, empty)', s.ok === true && s.disabled === true && s.items.length === 0);

    // The agent must still generate, but with NO historical context.
    let capturedContext: unknown = null;
    const service = agent.createAccountabilityAgentService({
      loadActiveHabits: async () => [
        { id: habitId, name: habitName, frequency: 'DAILY', target: 1, preferredTime: '07:00', status: 'ACTIVE' },
      ],
      loadRecentCompletions: async () => [
        { habitId, date: new Date('2026-09-06T00:00:00.000Z'), status: 'MISSED', missReason: 'tired in the morning' },
      ],
      computeAnalytics: async () => analyticsStub(),
      generateModelResponse: async ({ context }) => {
        capturedContext = context;
        return JSON.stringify({
          message: 'Keep at it.',
          recommendation: 'Move Morning Reading to 7 PM.',
          reason: 'Morning fatigue.',
          memoryUsed: false,
        });
      },
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      randomId: () => 'rec-disabled',
    });

    const rec = await service.generateRecommendation(userId);
    await new Promise<void>((r) => setTimeout(r, 10));

    check('agent still generates a recommendation with Sibyl disabled', typeof rec.recommendation === 'string');

    const ctx = capturedContext as {
      memory?: {
        note?: string;
        habitBehavior?: unknown[];
        priorRecommendations?: unknown[];
        memoryUsed?: boolean;
      };
    };
    check('disabled Sibyl yields no habit-behavior context', (ctx?.memory?.habitBehavior ?? []).length === 0, `count=${(ctx?.memory?.habitBehavior ?? []).length}`);
    check('disabled Sibyl yields no prior-recommendation context', (ctx?.memory?.priorRecommendations ?? []).length === 0, `count=${(ctx?.memory?.priorRecommendations ?? []).length}`);
    check('disabled Sibyl reports memoryUsed=false', ctx?.memory?.memoryUsed === false, `memoryUsed=${ctx?.memory?.memoryUsed}`);
    return;
  }

  console.log(`FAIL  unknown scenario: ${scenario}`);
  results.push({ name: `unknown scenario: ${scenario}`, pass: false });
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.log(`\nSCENARIO ${process.env.SIBYL_SCENARIO}: ${failed.length}/${results.length} checks FAILED`);
      process.exit(1);
    }
    console.log(`\nSCENARIO ${process.env.SIBYL_SCENARIO}: ${results.length}/${results.length} checks PASSED`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('SCENARIO CRASHED:', err);
    process.exit(1);
  });

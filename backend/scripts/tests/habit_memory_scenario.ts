/**
 * habit_memory_scenario.ts — one habit->Sibyl integration scenario per process.
 *
 * Spawned by habit_memory_test.ts with an isolated env. Each scenario exercises
 * the REAL completions route (POST /api/habits/:habitId/completions) end-to-end
 * against a REAL PostgreSQL database and the REAL Sibyl Memory venv, then reads
 * the result back from Sibyl to prove the behavioral signal was (or was not)
 * recorded. Per-process isolation is required to exercise disabled mode and the
 * transport-failure path against the real SDK without module-state pollution.
 *
 * Env (set by the driver): DATABASE_URL, JWT_SECRET, SIBYL_ENABLED, SIBYL_PYTHON,
 * SIBYL_BRIDGE_SCRIPT, SIBYL_DB_PATH, SIBYL_SCENARIO.
 */

import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // scripts/tests -> backend
const venvPython =
  process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
const bridgeScript = path.join(backendRoot, 'scripts', 'sibyl_bridge.py');

// Defaults so the file can also be run directly; the driver overrides these.
process.env.SIBYL_ENABLED = process.env.SIBYL_ENABLED ?? 'true';
process.env.SIBYL_PYTHON = process.env.SIBYL_PYTHON ?? venvPython;
process.env.SIBYL_BRIDGE_SCRIPT = process.env.SIBYL_BRIDGE_SCRIPT ?? bridgeScript;
process.env.SIBYL_DB_PATH =
  process.env.SIBYL_DB_PATH ??
  path.join(os.tmpdir(), `habit-sibyl-${process.env.SIBYL_SCENARIO}-${Date.now()}.db`);

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

/** Read COLD events back from Sibyl for a tenant via the real venv SDK. */
function readSibylEvents(userId: string): any[] {
  // Always read via the known-good venv interpreter. Some scenarios intentionally
  // poison SIBYL_PYTHON to verify failure handling in the route itself.
  const python = venvPython;
  const code = `
import os, json, sys
from sibyl_memory_client import MemoryClient
db = os.environ.get('SIBYL_DB_PATH')
tenant = os.environ.get('READ_TENANT')
if not db or not tenant:
    print('[]'); sys.exit(0)
client = MemoryClient.local(db, tenant_id=tenant)
events = client.read_events(limit=500)
print(json.dumps(events))
`;
  const out = execFileSync(python, ['-c', code], {
    env: { ...process.env, READ_TENANT: userId },
  });
  try {
    return JSON.parse(out.toString('utf8'));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const scenario = process.env.SIBYL_SCENARIO;
  const { prisma } = await import('../../src/db/prisma.js');
  const mem = await import('../../src/services/memory.js');
  const { habitsRouter } = await import('../../src/routes/habits.js');
  const { analyticsRouter } = await import('../../src/routes/analytics.js');
  const { signAuthToken, AUTH_COOKIE } = await import('../../src/auth/jwt.js');

  const createdUserIds: string[] = [];
  let server: any = null;

  async function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/habits', habitsRouter);
    app.use('/api', analyticsRouter);
    const s = app.listen(0);
    await new Promise<void>((resolve) => s.once('listening', () => resolve()));
    return { s };
  }

  async function makeUser(suffix: string) {
    const user = await prisma.user.create({
      data: {
        name: `tester-${suffix}`,
        email: `habit-mem-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'test-hash',
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function makeHabit(userId: string, name: string, frequency: string, preferredTime: string | null) {
    return prisma.habit.create({
      data: { userId, name, frequency, target: 1, preferredTime },
    });
  }

  async function postCompletion(port: number, habitId: string, token: string, body: any) {
    const res = await fetch(`http://127.0.0.1:${port}/api/habits/${habitId}/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_COOKIE}=${token}` },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async function getHistory(port: number, habitId: string, token: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/habits/${habitId}/completions`, {
      method: 'GET',
      headers: { Cookie: `${AUTH_COOKIE}=${token}` },
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async function getAnalytics(port: number, token: string) {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics`, {
      method: 'GET',
      headers: { Cookie: `${AUTH_COOKIE}=${token}` },
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  const dateStr = '2026-09-06';

  try {
    // ---------------------------------------------------------------- completed
    if (scenario === 'completed_memory') {
      const { s } = await makeApp();
      server = s;
      const user = await makeUser('completed');
      const habit = await makeHabit(user.id, 'Morning run', 'DAILY', '07:30');
      const token = signAuthToken(user.id);

      const r = await postCompletion(
        (s.address() as { port: number }).port,
        habit.id,
        token,
        { date: dateStr, status: 'COMPLETED' },
      );
      check('completion POST returns 201', r.status === 201, `status=${r.status}`);
      check('completion persisted in PostgreSQL', r.json?.status === 'success' && r.json?.data?.completion?.status === 'COMPLETED');

      const events = readSibylEvents(user.id);
      check('exactly one COLD event written to Sibyl', events.length === 1, `events=${events.length}`);
      check(
        'event records outcome=completed',
        events.length === 1 && events[0]?.evaluated?.outcome === 'completed',
        events[0]?.evaluated?.outcome,
      );
      check(
        'event is tied to the right habit',
        events.length === 1 && events[0]?.evaluated?.habitId === habit.id && events[0]?.evaluated?.habitName === 'Morning run',
      );
      check(
        'completed event has null missReason (no secret leak)',
        events.length === 1 && events[0]?.evaluated?.missReason === null,
      );

      const profile = await mem.recallEntity(user.id, 'habit_behavior', habit.id);
      check('habit behavior profile (WARM) created', profile.ok && profile.entity !== null, profile.error?.type ?? '');
      check(
        'profile carries cadence + bestTimeOfDay',
        profile.entity?.body?.cadence === 'daily' && profile.entity?.body?.bestTimeOfDay === '07:30',
        JSON.stringify(profile.entity?.body),
      );

      // Regression checks (completion history + analytics paths still good)
      const history = await getHistory((s.address() as { port: number }).port, habit.id, token);
      check('history endpoint still returns 200', history.status === 200, `status=${history.status}`);
      check(
        'history includes the completion row',
        history.json?.status === 'success' && Array.isArray(history.json?.data?.completions) && history.json.data.completions.length >= 1,
      );

      const analytics = await getAnalytics((s.address() as { port: number }).port, token);
      check('analytics endpoint still returns 200', analytics.status === 200, `status=${analytics.status}`);
      check('analytics response shape still success', analytics.json?.status === 'success');
    }

    // ------------------------------------------------------------------- missed
    else if (scenario === 'missed_memory') {
      const { s } = await makeApp();
      server = s;
      const user = await makeUser('missed');
      const habit = await makeHabit(user.id, 'Read 10 pages', 'DAILY', '21:00');
      const token = signAuthToken(user.id);
      const missReason = 'Slept through the alarm';

      const r = await postCompletion(
        (s.address() as { port: number }).port,
        habit.id,
        token,
        { date: dateStr, status: 'MISSED', missReason },
      );
      check('missed completion POST returns 201', r.status === 201, `status=${r.status}`);
      check('missed completion persisted in PostgreSQL', r.json?.data?.completion?.status === 'MISSED');

      const events = readSibylEvents(user.id);
      check('one COLD event written for the miss', events.length === 1, `events=${events.length}`);
      check(
        'event records outcome=missed',
        events.length === 1 && events[0]?.evaluated?.outcome === 'missed',
        events[0]?.evaluated?.outcome,
      );
      check(
        'miss reason is preserved verbatim in Sibyl',
        events.length === 1 && events[0]?.evaluated?.missReason === missReason,
        `got=${events[0]?.evaluated?.missReason}`,
      );

      const profile = await mem.recallEntity(user.id, 'habit_behavior', habit.id);
      check('missed updates the behavior profile', profile.ok && profile.entity !== null);
      check(
        'profile notes reflect the miss',
        typeof profile.entity?.body?.notes === 'string' && profile.entity.body.notes.includes('missed'),
        profile.entity?.body?.notes,
      );

      // --- STEP 12C: the miss reason must live in the WARM (searchable) tier.
      // COLD events are not covered by search_entities, so without this the
      // Agent can never see why a habit was missed.
      check(
        'WARM profile carries the latest miss reason',
        Array.isArray(profile.entity?.body?.commonMissReasons)
          && profile.entity.body.commonMissReasons[0] === missReason,
        JSON.stringify(profile.entity?.body?.commonMissReasons),
      );
      check(
        'profile does NOT mirror raw completion rows',
        profile.entity?.body?.completions === undefined && profile.entity?.body?.completion === undefined,
      );

      // The Agent searches by habit name; prove that actually finds this memory.
      const found = await mem.searchMemories(user.id, 'Read 10 pages', {
        category: 'habit_behavior',
        limit: 5,
      });
      check(
        'WARM memory is findable by the habit name (Agent retrieval query)',
        found.ok && found.items.length >= 1,
        `items=${found.items.length} err=${found.error?.type ?? ''}`,
      );
      check(
        'the retrieved memory carries the miss reason',
        JSON.stringify(found.items[0]?.body ?? {}).includes(missReason),
        JSON.stringify(found.items[0]?.body ?? {}).slice(0, 160),
      );
    }

    // ------------------------------------------- STEP 12C: Agent retrieval E2E
    else if (scenario === 'agent_retrieval') {
      const { s } = await makeApp();
      server = s;
      const port = (s.address() as { port: number }).port;

      const userA = await makeUser('agentA');
      const userB = await makeUser('agentB');
      const habitA = await makeHabit(userA.id, 'Study', 'DAILY', '19:00');
      const habitB = await makeHabit(userB.id, 'Meditate', 'DAILY', '08:00');
      const tokenA = signAuthToken(userA.id);
      const tokenB = signAuthToken(userB.id);

      const missReasonA = 'I was too tired after a long day.';

      // Real route -> writes PostgreSQL + COLD event + WARM profile.
      const rA = await postCompletion(port, habitA.id, tokenA, {
        date: dateStr, status: 'MISSED', missReason: missReasonA,
      });
      check('user A missed completion returns 201', rA.status === 201, `status=${rA.status}`);
      const rB = await postCompletion(port, habitB.id, tokenB, { date: dateStr, status: 'COMPLETED' });
      check('user B completion returns 201', rB.status === 201, `status=${rB.status}`);

      const { createAccountabilityAgentService } = await import('../../src/services/agent.js');
      let capturedContext: any = null;

      // Real memory service + real PostgreSQL; ONLY Gemini is stubbed so the
      // test never calls the network.
      const service = createAccountabilityAgentService({
        generateModelResponse: async ({ context }) => {
          capturedContext = context;
          return JSON.stringify({
            message: 'You missed Study.',
            recommendation: 'Move Study earlier than 19:00.',
            reason: 'You were too tired late in the day.',
            memoryUsed: context.memory.memoryUsed,
          });
        },
        now: () => new Date('2026-09-06T12:00:00.000Z'),
        randomId: () => 'agent-retrieval-test-id',
      });

      const rec = await service.generateRecommendation(userA.id);

      check('agent returns a valid recommendation', typeof rec.recommendation === 'string' && rec.recommendation.length > 0);
      check(
        'agent reports memoryUsed=true when Sibyl has the habit memory',
        rec.memoryUsed === true,
        `memoryUsed=${rec.memoryUsed}`,
      );
      check(
        'retrieved habit_behavior memory is non-empty',
        Array.isArray(capturedContext?.memory?.habitBehavior) && capturedContext.memory.habitBehavior.length >= 1,
        `items=${capturedContext?.memory?.habitBehavior?.length ?? 0}`,
      );

      const behaviorJson = JSON.stringify(capturedContext?.memory?.habitBehavior ?? []);
      check(
        'retrieved memory carries the Study habit',
        behaviorJson.includes('Study'),
        behaviorJson.slice(0, 160),
      );
      check(
        'retrieved memory carries the miss reason',
        behaviorJson.includes(missReasonA),
        behaviorJson.slice(0, 200),
      );

      // --- tenant isolation through the real Agent path ---
      check(
        'user A context does NOT contain user B habit',
        !behaviorJson.includes('Meditate') && !behaviorJson.includes(habitB.id),
      );
      const fullContextJson = JSON.stringify(capturedContext ?? {});
      check(
        'user A context does NOT contain user B id or habit id',
        !fullContextJson.includes(userB.id) && !fullContextJson.includes(habitB.id),
      );
      check(
        'user A context does NOT contain user B prior recommendations',
        !JSON.stringify(capturedContext?.memory?.priorRecommendations ?? []).includes('Meditate'),
      );
    }

    // ------------------------------- STEP 12C: Agent still works with Sibyl off
    else if (scenario === 'agent_sibyl_disabled') {
      check('SIBYL_ENABLED is false for this scenario', process.env.SIBYL_ENABLED === 'false');

      const user = await makeUser('agentDisabled');
      const habit = await makeHabit(user.id, 'Study', 'DAILY', '19:00');

      const { createAccountabilityAgentService } = await import('../../src/services/agent.js');
      let capturedContext: any = null;

      const service = createAccountabilityAgentService({
        generateModelResponse: async ({ context }) => {
          capturedContext = context;
          return JSON.stringify({
            message: 'Keep going.',
            recommendation: 'Try again tomorrow.',
            reason: 'PostgreSQL is still the source of truth.',
            memoryUsed: context.memory.memoryUsed,
          });
        },
        now: () => new Date('2026-09-06T12:00:00.000Z'),
        randomId: () => 'agent-disabled-test-id',
      });

      const rec = await service.generateRecommendation(user.id);

      check('agent still returns a recommendation with Sibyl disabled', typeof rec.recommendation === 'string' && rec.recommendation.length > 0);
      check('memoryUsed=false when Sibyl is disabled', rec.memoryUsed === false, `memoryUsed=${rec.memoryUsed}`);
      check(
        'no memory items collected while disabled',
        (capturedContext?.memory?.habitBehavior ?? []).length === 0
          && (capturedContext?.memory?.priorRecommendations ?? []).length === 0,
      );
      check(
        'PostgreSQL facts still reach the model while disabled',
        JSON.stringify(capturedContext?.factual ?? {}).includes('Study'),
      );
    }

    // ------------------------------------------------ duplicate no second event
    else if (scenario === 'duplicate_no_second_event') {
      const { s } = await makeApp();
      server = s;
      const user = await makeUser('dup');
      const habit = await makeHabit(user.id, 'Floss', 'DAILY', null);
      const token = signAuthToken(user.id);
      const port = (s.address() as { port: number }).port;

      const first = await postCompletion(port, habit.id, token, { date: dateStr, status: 'COMPLETED' });
      check('first completion returns 201', first.status === 201, `status=${first.status}`);

      const second = await postCompletion(port, habit.id, token, { date: dateStr, status: 'COMPLETED' });
      check('duplicate completion returns 409 (rejected by Postgres)', second.status === 409, `status=${second.status}`);

      const events = readSibylEvents(user.id);
      check(
        'duplicate did NOT write a second COLD event (still exactly 1)',
        events.length === 1,
        `events=${events.length}`,
      );
      const profile = await mem.recallEntity(user.id, 'habit_behavior', habit.id);
      check('profile written once, not on the rejected duplicate', profile.ok && profile.entity !== null);
    }

    // ------------------------------------------------ cross-user tenant isolation
    else if (scenario === 'cross_user_isolation') {
      const { s } = await makeApp();
      server = s;
      const port = (s.address() as { port: number }).port;

      const userA = await makeUser('isoA');
      const userB = await makeUser('isoB');
      const habitA = await makeHabit(userA.id, 'A-secret-habit', 'DAILY', '06:00');
      const habitB = await makeHabit(userB.id, 'B-habit', 'WEEKLY', null);
      const tokenA = signAuthToken(userA.id);
      const tokenB = signAuthToken(userB.id);

      const rA = await postCompletion(port, habitA.id, tokenA, { date: dateStr, status: 'COMPLETED' });
      check('user A completion 201', rA.status === 201, `status=${rA.status}`);

      const eventsA1 = readSibylEvents(userA.id);
      const eventsB1 = readSibylEvents(userB.id);
      check('A has exactly 1 event', eventsA1.length === 1, `events=${eventsA1.length}`);
      check('B (other tenant) has 0 events', eventsB1.length === 0, `events=${eventsB1.length}`);

      const rB = await postCompletion(port, habitB.id, tokenB, { date: dateStr, status: 'COMPLETED' });
      check('user B completion 201', rB.status === 201, `status=${rB.status}`);

      const eventsA2 = readSibylEvents(userA.id);
      const eventsB2 = readSibylEvents(userB.id);
      check('A still has exactly 1 event (B did not leak into A)', eventsA2.length === 1, `events=${eventsA2.length}`);
      check('B now has exactly 1 event', eventsB2.length === 1, `events=${eventsB2.length}`);

      const bRecallsA = await mem.recallEntity(userB.id, 'habit_behavior', habitA.id);
      check('B cannot recall A profile (null, no error)', bRecallsA.ok && bRecallsA.entity === null, bRecallsA.error?.type ?? '');
      const aRecallsOwn = await mem.recallEntity(userA.id, 'habit_behavior', habitA.id);
      check('A can recall its own profile', aRecallsOwn.ok && aRecallsOwn.entity !== null);

      // Cross-user API regression: B must not read A completion history.
      const historyBOnA = await getHistory(port, habitA.id, tokenB);
      check('cross-user history remains isolated (404)', historyBOnA.status === 404, `status=${historyBOnA.status}`);
    }

    // ------------------------------------------------ Sibyl disabled still works
    else if (scenario === 'sibyl_disabled') {
      check('SIBYL_ENABLED is false for this scenario', process.env.SIBYL_ENABLED === 'false');
      const { s } = await makeApp();
      server = s;
      const user = await makeUser('disabled');
      const habit = await makeHabit(user.id, 'Disabled test', 'DAILY', null);
      const token = signAuthToken(user.id);

      const r = await postCompletion(
        (s.address() as { port: number }).port,
        habit.id,
        token,
        { date: dateStr, status: 'COMPLETED' },
      );
      check('completion still returns 201 when Sibyl disabled', r.status === 201, `status=${r.status}`);

      const pgCount = await prisma.habitCompletion.count({ where: { habitId: habit.id } });
      check('PostgreSQL completion persisted despite Sibyl off', pgCount === 1, `count=${pgCount}`);

      const events = readSibylEvents(user.id);
      check('nothing written to Sibyl while disabled (no spawn)', events.length === 0, `events=${events.length}`);
    }

    // ------------------------------------------------ Sibyl failure still works
    else if (scenario === 'sibyl_failure') {
      check('SIBYL_PYTHON points at a bad interpreter', process.env.SIBYL_PYTHON !== venvPython);
      const { s } = await makeApp();
      server = s;
      const user = await makeUser('failure');
      const habit = await makeHabit(user.id, 'Failure test', 'DAILY', null);
      const token = signAuthToken(user.id);

      const r = await postCompletion(
        (s.address() as { port: number }).port,
        habit.id,
        token,
        { date: dateStr, status: 'COMPLETED' },
      );
      check('completion still returns 201 when Sibyl transport fails', r.status === 201, `status=${r.status}`);

      const pgCount = await prisma.habitCompletion.count({ where: { habitId: habit.id } });
      check('PostgreSQL completion persisted despite Sibyl failure', pgCount === 1, `count=${pgCount}`);
    }

    else {
      console.log(`FAIL  unknown scenario: ${scenario}`);
      results.push({ name: `unknown scenario: ${scenario}`, pass: false });
    }
  } catch (err) {
    console.log('SCENARIO ERROR:', err && (err as Error).stack ? (err as Error).stack : String(err));
    results.push({ name: `scenario threw: ${scenario}`, pass: false });
  } finally {
    try {
      if (server) server.close();
    } catch {
      /* ignore */
    }
    try {
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
    } catch (e) {
      console.log('cleanup warning (user delete):', String(e));
    }
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log(`\nSCENARIO ${process.env.SIBYL_SCENARIO}: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }
  console.log(`\nSCENARIO ${process.env.SIBYL_SCENARIO}: ${results.length}/${results.length} checks PASSED`);
  process.exit(0);
}

main();

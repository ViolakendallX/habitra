/**
 * sibyl_scenario.ts — one Sibyl memory scenario per process.
 *
 * The driver (sibyl_memory_test.ts) spawns this file once per scenario with the
 * relevant env vars. Because env.ts is evaluated at import time from process.env,
 * a fresh process per scenario gives each scenario a clean, isolated config —
 * which is required to exercise disabled mode and transport failures (bad python
 * / bad script) without polluting the shared module state.
 *
 * Reads SIBYL_SCENARIO to pick the scenario, prints PASS/FAIL lines, and exits
 * 0 only if every check passed.
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

// Let the driver override; otherwise use sane defaults. IMPORTANT: set these
// before importing memory.ts / sibylBridge.ts, which read env at import time.
process.env.SIBYL_ENABLED = process.env.SIBYL_ENABLED ?? 'true';
process.env.SIBYL_PYTHON = process.env.SIBYL_PYTHON ?? venvPython;
process.env.SIBYL_BRIDGE_SCRIPT = process.env.SIBYL_BRIDGE_SCRIPT ?? bridgeScript;
process.env.SIBYL_DB_PATH =
  process.env.SIBYL_DB_PATH ??
  path.join(os.tmpdir(), `sibyl-test-${process.env.SIBYL_SCENARIO}-${Date.now()}.db`);

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

async function main(): Promise<void> {
  const scenario = process.env.SIBYL_SCENARIO;
  const mem = await import('../../src/services/memory.js');
  const { runSibylOp } = await import('../../src/lib/sibylBridge.js');

  if (scenario === 'e2e') {
    const userId = 'e2e-user';
    const w = await mem.recordCompletionEvent(userId, {
      habitId: 'h1',
      habitName: 'Morning run',
      outcome: 'completed',
      date: '2026-09-06',
      streak: 3,
    });
    check('recordCompletionEvent ok', w.ok && !w.disabled);

    const p = await mem.saveHabitBehaviorProfile(userId, 'h1', {
      habitId: 'h1',
      habitName: 'Morning run',
      cadence: 'daily',
      commonMissReasons: ['tired'],
    });
    check('saveHabitBehaviorProfile ok', p.ok && !p.disabled);

    const recalled = await mem.recallEntity(userId, 'habit_behavior', 'h1');
    check(
      'recallEntity returns written entity',
      recalled.ok && recalled.entity?.name === 'h1' && (recalled.entity?.body as { cadence?: string })?.cadence === 'daily',
      recalled.entity ? '' : 'entity was null',
    );

    const searched = await mem.searchMemories(userId, 'daily');
    check(
      'searchMemories finds the profile',
      searched.ok && searched.items.some((i) => i.name === 'h1'),
      `items=${searched.items.length}`,
    );

    const pref = await mem.saveUserPreference(userId, 'reminder', 'on');
    check('saveUserPreference ok', pref.ok);
    const prefRecall = await mem.recallEntity(userId, 'user_preference', 'reminder');
    check('recallEntity user_preference', prefRecall.ok && (prefRecall.entity?.body as { value?: string })?.value === 'on');
    return;
  }

  if (scenario === 'tenant_isolation') {
    const A = 'iso-A';
    const B = 'iso-B';
    const write = await mem.saveHabitBehaviorProfile(A, 'h1', {
      habitId: 'h1',
      habitName: 'Secret Habit',
    });
    check('owner write ok', write.ok);

    const bRecall = await mem.recallEntity(B, 'habit_behavior', 'h1');
    check('other tenant cannot recall (null, no error)', bRecall.ok && bRecall.entity === null, bRecall.error?.type ?? '');

    const bSearch = await mem.searchMemories(B, 'Secret');
    check('other tenant search is empty', bSearch.ok && bSearch.items.length === 0, `items=${bSearch.items.length}`);

    const aRecall = await mem.recallEntity(A, 'habit_behavior', 'h1');
    check('owner can recall own entity', aRecall.ok && aRecall.entity?.name === 'h1');

    const aSearch = await mem.searchMemories(A, 'Secret');
    check('owner search finds own entity', aSearch.ok && aSearch.items.some((i) => i.name === 'h1'));
    return;
  }

  if (scenario === 'disabled') {
    // SIBYL_ENABLED=false (set by the driver). A bogus python proves the service
    // short-circuits BEFORE spawning anything.
    check('SIBYL_ENABLED is false', process.env.SIBYL_ENABLED === 'false');

    const w = await mem.recordCompletionEvent('u', {
      habitId: 'h1',
      habitName: 'x',
      outcome: 'completed',
      date: '2026-09-06',
    });
    check('write is a safe no-op (ok + disabled)', w.ok && w.disabled === true);

    const s = await mem.searchMemories('u', 'anything');
    check('search is a safe no-op (ok + disabled, empty)', s.ok && s.disabled === true && s.items.length === 0);

    const r = await mem.recallEntity('u', 'habit_behavior', 'h1');
    check('recall is a safe no-op (ok + disabled, null)', r.ok && r.disabled === true && r.entity === null);
    return;
  }

  if (scenario === 'security') {
    const userId = 'sec-user';
    const good = await mem.saveUserPreference(userId, 'theme', { favorite: 'dark' });
    check('benign preference written', good.ok && !good.error);

    const goodRecall = await mem.recallEntity(userId, 'user_preference', 'theme');
    check(
      'benign preference recalled (no false refusal)',
      goodRecall.ok && (goodRecall.entity?.body as { favorite?: string })?.favorite === 'dark',
    );

    const badPref = await mem.saveUserPreference(userId, 'x', { password: 'hunter2' });
    check('secret field refused (RefusedSecret)', !badPref.ok && badPref.error?.type === 'RefusedSecret', badPref.error?.type ?? '');

    const goodProfile = await mem.saveHabitBehaviorProfile(userId, 'h1', {
      habitId: 'h1',
      habitName: 'Run',
      notes: 'fine',
    });
    check('benign profile written', goodProfile.ok);

    const badProfile = await mem.saveHabitBehaviorProfile(userId, 'h2', {
      habitId: 'h2',
      habitName: 'Run',
      apiKey: 'sk-12345',
    });
    check('nested secret field refused (RefusedSecret)', !badProfile.ok && badProfile.error?.type === 'RefusedSecret', badProfile.error?.type ?? '');
    return;
  }

  if (scenario === 'failure_spawn') {
    // SIBYL_PYTHON points at a non-existent interpreter (set by driver).
    const w = await mem.recordCompletionEvent('u', {
      habitId: 'h1',
      habitName: 'x',
      outcome: 'completed',
      date: '2026-09-06',
    });
    check('spawn failure is swallowed, not thrown', w.ok === false && w.error?.type === 'SpawnError', w.error?.type ?? '');
    return;
  }

  if (scenario === 'failure_timeout') {
    // SIBYL_BRIDGE_SCRIPT points at a script that sleeps far longer than the timeout.
    const start = Date.now();
    const res = await runSibylOp(
      { op: 'get_entity', tenantId: 'x', args: { category: 'c', name: 'n' } },
      300,
    );
    const elapsed = Date.now() - start;
    check('timeout yields TimeoutError', res.ok === false && res.error?.type === 'TimeoutError', `type=${res.error?.type}`);
    check('timeout fired near 300ms (not the full sleep)', elapsed < 4000, `elapsed=${elapsed}ms`);
    return;
  }

  if (scenario === 'failure_malformed') {
    // SIBYL_BRIDGE_SCRIPT points at a script that prints non-JSON to stdout.
    const res = await runSibylOp(
      { op: 'get_entity', tenantId: 'x', args: { category: 'c', name: 'n' } },
      3000,
    );
    check('malformed stdout yields MalformedOutput', res.ok === false && res.error?.type === 'MalformedOutput', res.error?.type ?? '');
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

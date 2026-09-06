/**
 * habit_memory_test.ts — driver for the habit->Sibyl integration suite (STEP 10).
 *
 * Mirrors the STEP 9 Sibyl foundation harness: each scenario in
 * scripts/tests/habit_memory_scenario.ts runs in its own tsx process with an
 * isolated env, so env.ts (and therefore SIBYL_ENABLED / transport flags) is
 * re-evaluated fresh per scenario. This lets us exercise the disabled path and
 * the transport-failure path against the REAL Sibyl Python SDK — no mocks.
 *
 * Requires DATABASE_URL + JWT_SECRET from .env; the npm script loads it via
 * --env-file-if-exists=.env and the values are inherited by every child.
 *
 * Run with:  node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs scripts/habit_memory_test.ts
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // scripts -> backend
const tsxCli = path.join(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const scenarioFile = path.join(backendRoot, 'scripts', 'tests', 'habit_memory_scenario.ts');
const venvPython =
  process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
const bridgeScript = path.join(backendRoot, 'scripts', 'sibyl_bridge.py');
const bogusPython = '__nonexistent_python_xyz__';

function dbFor(name: string): string {
  return path.join(os.tmpdir(), `habit-sibyl-${name}-${Date.now()}.db`);
}

function buildScenarios(): { name: string; env: NodeJS.ProcessEnv }[] {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    SIBYL_ENABLED: 'true',
    SIBYL_PYTHON: venvPython,
    SIBYL_BRIDGE_SCRIPT: bridgeScript,
  };

  return [
    { name: 'completed_memory', env: { ...base, SIBYL_DB_PATH: dbFor('completed') } },
    { name: 'missed_memory', env: { ...base, SIBYL_DB_PATH: dbFor('missed') } },
    { name: 'duplicate_no_second_event', env: { ...base, SIBYL_DB_PATH: dbFor('dup') } },
    { name: 'cross_user_isolation', env: { ...base, SIBYL_DB_PATH: dbFor('iso') } },
    // STEP 12C: end-to-end Agent retrieval against the real Sibyl SDK. Gemini is
    // stubbed inside the scenario; memory + PostgreSQL are real.
    { name: 'agent_retrieval', env: { ...base, SIBYL_DB_PATH: dbFor('agent-retrieval') } },
    // STEP 12C: the Agent must still answer (memoryUsed=false) with Sibyl off and
    // a broken interpreter, proving memory is never a hard dependency.
    { name: 'agent_sibyl_disabled', env: { ...base, SIBYL_ENABLED: 'false', SIBYL_PYTHON: bogusPython, SIBYL_DB_PATH: dbFor('agent-disabled') } },
    // Disabled: flag off + bogus python proves the route short-circuits (no spawn)
    // but PostgreSQL completion still succeeds.
    { name: 'sibyl_disabled', env: { ...base, SIBYL_ENABLED: 'false', SIBYL_PYTHON: bogusPython, SIBYL_DB_PATH: dbFor('disabled') } },
    // Failure: enabled + bogus python -> bridge SpawnError swallowed, PG still wins.
    { name: 'sibyl_failure', env: { ...base, SIBYL_PYTHON: bogusPython, SIBYL_DB_PATH: dbFor('failure') } },
  ];
}

function runScenario(spec: { name: string; env: NodeJS.ProcessEnv }): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, scenarioFile], {
      cwd: backendRoot,
      env: { ...spec.env, SIBYL_SCENARIO: spec.name },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('close', (code: number | null) => {
      process.stdout.write(`\n----- scenario: ${spec.name} (exit ${code}) -----\n${out}`);
      resolve(code === 0);
    });
  });
}

async function main(): Promise<void> {
  const scenarios = buildScenarios();
  let allOk = true;
  for (const s of scenarios) {
    const ok = await runScenario(s);
    if (!ok) allOk = false;
  }
  process.stdout.write(`\n===== Habit->Sibyl integration suite: ${allOk ? 'ALL PASSED' : 'SOME FAILED'} =====\n`);
  process.exit(allOk ? 0 : 1);
}

main();

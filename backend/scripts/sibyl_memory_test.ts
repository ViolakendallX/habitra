/**
 * sibyl_memory_test.ts — driver for the Sibyl memory foundation test suite.
 *
 * Runs each scenario (scripts/tests/sibyl_scenario.ts) in its own tsx process
 * with an isolated env, so env.ts is re-evaluated fresh per scenario. This is
 * what lets us exercise disabled mode and transport failures (bad python /
 * bad script) against the REAL installed sibyl-memory-client — no mocks.
 *
 * Run with:  node node_modules/tsx/dist/cli.mjs scripts/sibyl_memory_test.ts
 * (or:        npx tsx scripts/sibyl_memory_test.ts)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // scripts -> backend
const tsxCli = path.join(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const scenarioFile = path.join(backendRoot, 'scripts', 'tests', 'sibyl_scenario.ts');
const venvPython =
  process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
const bridgeScript = path.join(backendRoot, 'scripts', 'sibyl_bridge.py');

function dbFor(name: string): string {
  return path.join(os.tmpdir(), `sibyl-test-${name}-${Date.now()}.db`);
}

function writeTempScript(contents: string): string {
  const p = path.join(os.tmpdir(), `sibyl-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(p, contents);
  return p;
}

function buildScenarios(): { name: string; env: NodeJS.ProcessEnv }[] {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    SIBYL_ENABLED: 'true',
    SIBYL_PYTHON: venvPython,
    SIBYL_BRIDGE_SCRIPT: bridgeScript,
  };

  const slowScript = writeTempScript('import time\ntime.sleep(10)\n');
  const garbageScript = writeTempScript("import sys\nsys.stdout.write('@@@not-json@@@')\n");
  const bogusPython = '__nonexistent_python_xyz__';

  return [
    { name: 'e2e', env: { ...base, SIBYL_DB_PATH: dbFor('e2e') } },
    { name: 'tenant_isolation', env: { ...base, SIBYL_DB_PATH: dbFor('tenant_isolation') } },
    { name: 'security', env: { ...base, SIBYL_DB_PATH: dbFor('security') } },
    // Disabled: flag off + bogus python proves the service short-circuits
    // (returns a safe no-op) instead of spawning anything.
    { name: 'disabled', env: { ...base, SIBYL_ENABLED: 'false', SIBYL_PYTHON: bogusPython, SIBYL_DB_PATH: dbFor('disabled') } },
    // Spawn failure: enabled + bogus python -> bridge returns SpawnError, swallowed.
    { name: 'failure_spawn', env: { ...base, SIBYL_PYTHON: bogusPython, SIBYL_DB_PATH: dbFor('failure_spawn') } },
    // Timeout: enabled + a script that sleeps far longer than the 300ms timeout.
    { name: 'failure_timeout', env: { ...base, SIBYL_BRIDGE_SCRIPT: slowScript, SIBYL_DB_PATH: dbFor('failure_timeout') } },
    // Malformed output: enabled + a script that prints non-JSON to stdout.
    { name: 'failure_malformed', env: { ...base, SIBYL_BRIDGE_SCRIPT: garbageScript, SIBYL_DB_PATH: dbFor('failure_malformed') } },
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
  process.stdout.write(`\n===== Sibyl memory test suite: ${allOk ? 'ALL PASSED' : 'SOME FAILED'} =====\n`);
  process.exit(allOk ? 0 : 1);
}

main();

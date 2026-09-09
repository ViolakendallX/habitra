/**
 * learning_loop_test.ts — driver for the Sibyl learning-loop suite.
 *
 * Spawns the scenario file (scripts/tests/learning_loop_scenario.ts) in its own
 * tsx process with an isolated Sibyl DB per scenario, so env.ts is re-evaluated
 * fresh (required to exercise disabled mode). Uses the REAL Sibyl bridge — no
 * mocks of the memory layer — so the tests prove outcomes are truly stored in and
 * retrieved from Sibyl.
 *
 * Run with: npm run test:learning_loop
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // scripts -> backend
const tsxCli = path.join(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const scenarioFile = path.join(backendRoot, 'scripts', 'tests', 'learning_loop_scenario.ts');
const venvPython =
  process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python');
const bridgeScript = path.join(backendRoot, 'scripts', 'sibyl_bridge.py');

function dbFor(name: string): string {
  return path.join(os.tmpdir(), `sibyl-loop-${name}-${Date.now()}.db`);
}

const scenarios: { name: string; env: NodeJS.ProcessEnv }[] = [
  {
    name: 'learning_loop',
    env: {
      ...process.env,
      SIBYL_ENABLED: 'true',
      SIBYL_PYTHON: venvPython,
      SIBYL_BRIDGE_SCRIPT: bridgeScript,
      SIBYL_DB_PATH: dbFor('learning_loop'),
    },
  },
  {
    // Disabled: flag off + bogus python proves the service short-circuits before
    // spawning the bridge, so no historical context is ever available.
    name: 'learning_loop_disabled',
    env: {
      ...process.env,
      SIBYL_ENABLED: 'false',
      SIBYL_PYTHON: '__nonexistent_python_xyz__',
      SIBYL_BRIDGE_SCRIPT: bridgeScript,
      SIBYL_DB_PATH: dbFor('learning_loop_disabled'),
    },
  },
];

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
  let allOk = true;
  for (const s of scenarios) {
    const ok = await runScenario(s);
    if (!ok) allOk = false;
  }
  process.stdout.write(`\n===== Sibyl learning-loop suite: ${allOk ? 'ALL PASSED' : 'SOME FAILED'} =====\n`);
  process.exit(allOk ? 0 : 1);
}

main();

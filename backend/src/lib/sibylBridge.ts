/**
 * sibylBridge.ts — Node → Python transport for Sibyl Memory.
 *
 * This module is a thin, side-effect-free transport. It spawns the Python
 * bridge script (scripts/sibyl_bridge.py) once per logical memory operation,
 * pipes a single JSON request over stdin, and parses the single JSON envelope
 * from stdout. It contains NO business logic: feature-flagging, tenant mapping,
 * and error swallowing live in services/memory.ts.
 *
 * Safety guarantees (required by the STEP 9 spec):
 *  - Hard timeout: the child is killed if it overruns the timeout.
 *  - Malformed output: non-JSON / non-envelope stdout is returned as a typed error.
 *  - Non-zero exit: captured and surfaced as a typed error. If the child still
 *    managed to print a clean envelope, that envelope wins (so a known SDK error
 *    reported with exit 1 is still parsed correctly).
 *  - Spawn failure: a missing interpreter / script is a typed error, never a throw.
 *
 * The function never rejects — it always resolves with a SibylResponse so callers
 * can decide what to do without try/catching the transport.
 */

import { spawn } from 'node:child_process';

import { env } from '../config/env.js';

export type SibylOp =
  | 'set_entity'
  | 'get_entity'
  | 'write_event'
  | 'search_entities'
  | 'archive_entity';

export interface SibylError {
  type: string;
  message: string;
  detail?: string;
}

export interface SibylResult {
  ok: true;
  data: unknown;
}

export interface SibylFailure {
  ok: false;
  error: SibylError;
}

export type SibylResponse = SibylResult | SibylFailure;

export interface SibylRequest {
  op: SibylOp;
  /** Habitra userId, passed straight through as the Sibyl tenant_id. */
  tenantId: string;
  args: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Spawn the Python bridge for a single operation and return its parsed result.
 * Never throws.
 */
export function runSibylOp(
  request: SibylRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SibylResponse> {
  return new Promise((resolve) => {
    const python = env.sibylPython;
    const script = env.sibylBridgeScript;

    if (!python || !script) {
      resolve({
        ok: false,
        error: {
          type: 'BridgeConfigError',
          message: 'SIBYL_PYTHON or SIBYL_BRIDGE_SCRIPT is not configured.',
        },
      });
      return;
    }

    const payload = JSON.stringify({
      op: request.op,
      db_path: env.sibylDbPath,
      tenant_id: request.tenantId,
      args: request.args,
    });

    const child = spawn(python, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (result: SibylResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        error: {
          type: 'TimeoutError',
          message: `Sibyl operation '${request.op}' timed out after ${timeoutMs}ms.`,
        },
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        error: {
          type: 'SpawnError',
          message: err.message,
        },
      });
    });

    child.on('close', (code: number | null) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        finish({
          ok: false,
          error: {
            type: 'EmptyOutput',
            message: `Sibyl bridge exited with code ${code} and produced no stdout.`,
            detail: stderr.slice(0, 500),
          },
        });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          'ok' in parsed &&
          typeof (parsed as { ok: unknown }).ok === 'boolean'
        ) {
          finish(parsed as SibylResponse);
          return;
        }
        finish({
          ok: false,
          error: {
            type: 'MalformedOutput',
            message: 'stdout was not a Sibyl envelope.',
            detail: trimmed.slice(0, 200),
          },
        });
      } catch (err) {
        finish({
          ok: false,
          error: {
            type: 'MalformedOutput',
            message: `stdout was not valid JSON: ${(err as Error).message}`,
            detail: trimmed.slice(0, 200),
          },
        });
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

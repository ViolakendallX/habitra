/**
 * Interventions (Virtuals action layer) test suite.
 *
 * Runs entirely against the FAKE client: no Virtuals account, no wallet, no
 * network, no credentials. If a test ever sees provider === 'virtuals', the
 * fake was accidentally swapped out.
 *
 * Run with:
 *   npm run test:virtuals_intervention
 */

import {
  createFakeVirtualsClient,
  createInterventionService,
  interventionService,
  type InterventionOutcome,
  type InterventionRequest,
  type InterventionResult,
} from '../src/services/virtuals.js';

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

function buildRequest(overrides: Partial<InterventionRequest> = {}): InterventionRequest {
  return {
    userId: 'user-a',
    interventionId: 'int-1',
    kind: 'commitment_check',
    habitId: 'habit-a-1',
    challengeId: null,
    goal: 'Get back on the morning run streak',
    message: 'You have missed three runs in a row. Want to schedule one now?',
    reason: 'Three consecutive misses after a 12-day streak.',
    context: {
      habitName: 'Morning run',
      currentStreak: 0,
      completionRate: 42,
      missedLastDays: 3,
    },
    requestedAt: '2026-09-06T12:00:00.000Z',
    ...overrides,
  };
}

async function main(): Promise<void> {
  // ---------------- Default wiring ----------------
  const client = createFakeVirtualsClient();
  const service = createInterventionService({ client });

  const ok = await service.requestIntervention(buildRequest());

  check('intervention is accepted by the fake provider', ok.ok === true, `ok=${ok.ok}`);
  check(
    'result is a success with CREATED status',
    ok.ok === true && ok.status === 'CREATED',
    `status=${ok.ok ? ok.status : 'n/a'}`,
  );
  check('result reports the mock provider', ok.provider === 'mock', `provider=${ok.provider}`);
  check(
    'provider reference is returned',
    ok.ok === true && ok.providerRef === 'mock:int-1',
    `providerRef=${ok.ok ? String(ok.providerRef) : 'n/a'}`,
  );
  check('interventionId echoes the request', ok.interventionId === 'int-1');

  // ---------------- The client actually received it ----------------
  check('provider was called exactly once', client.calls.length === 1, `calls=${client.calls.length}`);
  const sent = client.calls[0];
  check(
    'request reached the provider unchanged',
    sent?.interventionId === 'int-1'
      && sent?.kind === 'commitment_check'
      && sent?.message === 'You have missed three runs in a row. Want to schedule one now?',
    `kind=${sent?.kind}`,
  );
  check('tenant id is forwarded to the provider', sent?.userId === 'user-a', `userId=${sent?.userId}`);

  // ---------------- Architecture rule: the service never decides ----------------
  // Every kind must be dispatched identically. No gating, no heuristics.
  client.reset();
  for (const kind of ['nudge', 'commitment_check', 'escalate'] as const) {
    await service.requestIntervention(buildRequest({ kind, interventionId: `int-${kind}` }));
  }
  check(
    'all three kinds are dispatched (no gating in the action layer)',
    client.calls.length === 3
      && client.calls[0]?.kind === 'nudge'
      && client.calls[1]?.kind === 'commitment_check'
      && client.calls[2]?.kind === 'escalate',
    `calls=${client.calls.map((c) => c.kind).join(',')}`,
  );

  client.reset();
  await service.requestIntervention(
    buildRequest({ context: { habitName: 'Morning run', currentStreak: 0, completionRate: 0, missedLastDays: 30 } }),
  );
  await service.requestIntervention(
    buildRequest({ context: { habitName: 'Morning run', currentStreak: 99, completionRate: 100, missedLastDays: 0 } }),
  );
  check(
    'bad analytics do not trigger or block anything (service has no opinion)',
    client.calls.length === 2,
    `calls=${client.calls.length}`,
  );

  // ---------------- Failure paths: never throws ----------------
  const throwing = createInterventionService({
    client: createFakeVirtualsClient({ failWith: 'simulated transport failure' }),
  });
  const thrown = await throwing.requestIntervention(buildRequest());
  check(
    'client rejection is converted to ok:false (never throws)',
    thrown.ok === false && thrown.status === 'FAILED' && thrown.reason === 'TRANSPORT_ERROR',
    `reason=${thrown.ok ? 'n/a' : thrown.reason}`,
  );

  const clientFail = createInterventionService({
    client: createFakeVirtualsClient({
      respond: () => ({
        ok: false,
        interventionId: 'int-1',
        status: 'FAILED',
        provider: 'mock',
        reason: 'PROVIDER_REJECTED',
        error: { type: 'AcpiError', message: 'insufficient funds' },
      }),
    }),
  });
  const rejected = await clientFail.requestIntervention(buildRequest());
  check(
    'provider rejection is surfaced verbatim',
    rejected.ok === false && rejected.reason === 'PROVIDER_REJECTED',
    `reason=${rejected.ok ? 'n/a' : rejected.reason}`,
  );
  check(
    'provider error detail is preserved',
    rejected.ok === false && rejected.error?.type === 'AcpiError',
    `type=${rejected.ok ? 'n/a' : String(rejected.error?.type)}`,
  );

  const malformed = createInterventionService({
    client: createFakeVirtualsClient({
      respond: () => ({ ok: true, status: 'WHO_KNOWS' }) as unknown as InterventionResult,
    }),
  });
  const bad = await malformed.requestIntervention(buildRequest());
  check(
    'malformed client result is normalised to a failure',
    bad.ok === false && bad.reason === 'MALFORMED_CLIENT_RESULT',
    `reason=${bad.ok ? 'n/a' : bad.reason}`,
  );

  // ---------------- Timeout ----------------
  const slow = createInterventionService({
    client: createFakeVirtualsClient({ delayMs: 400 }),
    timeoutMs: 30,
  });
  const timedOut = await slow.requestIntervention(buildRequest());
  check(
    'hung provider is cut off by the timeout',
    timedOut.ok === false && timedOut.reason === 'TIMEOUT',
    `reason=${timedOut.ok ? 'n/a' : timedOut.reason}`,
  );

  // ---------------- Disabled ----------------
  const disabledClient = createFakeVirtualsClient();
  const disabled = createInterventionService({ client: disabledClient, enabled: false });
  const skipped = await disabled.requestIntervention(buildRequest());
  check(
    'disabled service skips without calling the provider',
    skipped.ok === false && skipped.status === 'SKIPPED' && disabledClient.calls.length === 0,
    `status=${skipped.status} calls=${disabledClient.calls.length}`,
  );

  // ---------------- Input validation ----------------
  const validatingClient = createFakeVirtualsClient();
  const validating = createInterventionService({ client: validatingClient });

  const badKind = await validating.requestIntervention(
    buildRequest({ kind: 'shout' as unknown as InterventionRequest['kind'] }),
  );
  check(
    'unknown kind is rejected before dispatch',
    badKind.ok === false && badKind.reason === 'INVALID_REQUEST' && validatingClient.calls.length === 0,
    `reason=${badKind.ok ? 'n/a' : badKind.reason}`,
  );

  const emptyGoal = await validating.requestIntervention(buildRequest({ goal: '' }));
  check(
    'empty goal is rejected before dispatch',
    emptyGoal.ok === false && emptyGoal.reason === 'INVALID_REQUEST',
    `reason=${emptyGoal.ok ? 'n/a' : emptyGoal.reason}`,
  );

  const badRate = await validating.requestIntervention(
    buildRequest({ context: { completionRate: 300 } }),
  );
  check(
    'out-of-range completionRate is rejected',
    badRate.ok === false && badRate.reason === 'INVALID_REQUEST',
    `reason=${badRate.ok ? 'n/a' : badRate.reason}`,
  );

  // ---------------- The memory loop closes into Sibyl ----------------
  type SaveCall = { userId: string; outcome: InterventionOutcome };
  const capture = (): { calls: SaveCall[]; fn: (u: string, o: InterventionOutcome) => Promise<{ remembered: boolean; ok: boolean }> } => {
    const calls: SaveCall[] = [];
    return {
      calls,
      fn: async (userId: string, outcome: InterventionOutcome) => {
        calls.push({ userId, outcome });
        return { remembered: true, ok: true };
      },
    };
  };

  const sink = capture();
  const loopService = createInterventionService({
    client: createFakeVirtualsClient(),
    saveInterventionOutcome: sink.fn,
  });
  await loopService.requestIntervention(buildRequest({ interventionId: 'int-loop' }));

  check('outcome is persisted to Sibyl after a successful run', sink.calls.length === 1, `saved=${sink.calls.length}`);
  check('outcome is written under the requesting user', sink.calls[0]?.userId === 'user-a', `userId=${sink.calls[0]?.userId}`);
  const loopOutcome = sink.calls[0]?.outcome;
  check(
    'interventionId is stored as recommendationId',
    loopOutcome?.interventionId === 'int-loop',
    `id=${loopOutcome?.interventionId}`,
  );
  check(
    'intervention memories use a distinct source',
    loopOutcome?.source === 'virtuals_intervention_v1',
    `source=${loopOutcome?.source}`,
  );
  check(
    'outcome text records kind + result status',
    typeof loopOutcome?.text === 'string'
      && loopOutcome.text.includes('[intervention:commitment_check]')
      && loopOutcome.text.includes('CREATED'),
    `text=${loopOutcome?.text}`,
  );
  check(
    'habitId is carried through to the memory',
    loopOutcome?.habitId === 'habit-a-1',
    `habitId=${loopOutcome?.habitId}`,
  );

  // accepted flag is a mechanical mapping of provider state (not a decision).
  const acceptedSink = capture();
  const acceptedService = createInterventionService({
    client: createFakeVirtualsClient({ respond: () => ({ ok: true, interventionId: 'int-acc', status: 'ACCEPTED', provider: 'mock' }) }),
    saveInterventionOutcome: acceptedSink.fn,
  });
  await acceptedService.requestIntervention(buildRequest({ interventionId: 'int-acc' }));
  check('ACCEPTED maps to accepted=true', acceptedSink.calls[0]?.outcome.accepted === true, `accepted=${acceptedSink.calls[0]?.outcome.accepted}`);

  const declinedSink = capture();
  const declinedService = createInterventionService({
    client: createFakeVirtualsClient({ respond: () => ({ ok: true, interventionId: 'int-dec', status: 'DECLINED', provider: 'mock' }) }),
    saveInterventionOutcome: declinedSink.fn,
  });
  await declinedService.requestIntervention(buildRequest({ interventionId: 'int-dec' }));
  check('DECLINED maps to accepted=false', declinedSink.calls[0]?.outcome.accepted === false, `accepted=${declinedSink.calls[0]?.outcome.accepted}`);

  const createdSink = capture();
  const createdService = createInterventionService({
    client: createFakeVirtualsClient(),
    saveInterventionOutcome: createdSink.fn,
  });
  await createdService.requestIntervention(buildRequest({ interventionId: 'int-created' }));
  check('CREATED maps to accepted=null (no user response yet)', createdSink.calls[0]?.outcome.accepted === null, `accepted=${createdSink.calls[0]?.outcome.accepted}`);

  // The loop still records FAILED outcomes — so future reasoning can avoid a retry.
  const failSink = capture();
  const failService = createInterventionService({
    client: createFakeVirtualsClient({ failWith: 'simulated transport failure' }),
    saveInterventionOutcome: failSink.fn,
  });
  await failService.requestIntervention(buildRequest({ interventionId: 'int-fail' }));
  check(
    'outcome is persisted even when the provider fails',
    failSink.calls.length === 1 && failSink.calls[0]?.outcome.ok === false,
    `len=${failSink.calls.length} ok=${failSink.calls[0]?.outcome.ok}`,
  );

  // NOT persisted when nothing was dispatched.
  const disabledSink = capture();
  const disabledLoop = createInterventionService({
    client: createFakeVirtualsClient(),
    enabled: false,
    saveInterventionOutcome: disabledSink.fn,
  });
  await disabledLoop.requestIntervention(buildRequest({ interventionId: 'int-skip' }));
  check('outcome is NOT persisted when disabled', disabledSink.calls.length === 0, `calls=${disabledSink.calls.length}`);

  const invalidSink = capture();
  const invalidLoop = createInterventionService({
    client: createFakeVirtualsClient(),
    saveInterventionOutcome: invalidSink.fn,
  });
  await invalidLoop.requestIntervention(buildRequest({ kind: 'shout' as unknown as InterventionRequest['kind'] }));
  check('outcome is NOT persisted on an invalid request', invalidSink.calls.length === 0, `calls=${invalidSink.calls.length}`);

  // A memory write failure must not break the response.
  const throwingSave = createInterventionService({
    client: createFakeVirtualsClient(),
    saveInterventionOutcome: async () => { throw new Error('sibyl is down'); },
  });
  const saveFailResult = await throwingSave.requestIntervention(buildRequest({ interventionId: 'int-savefail' }));
  check(
    'a memory write failure does not break the result',
    saveFailResult.ok === true && saveFailResult.status === 'CREATED',
    `ok=${saveFailResult.ok} status=${saveFailResult.ok ? saveFailResult.status : 'n/a'}`,
  );

  // ---------------- Default singleton ----------------
  const defaulted = await interventionService.requestIntervention(
    buildRequest({ interventionId: 'int-default' }),
  );
  check(
    'module singleton works with no configuration or credentials',
    defaulted.ok === true && defaulted.provider === 'mock',
    `provider=${defaulted.provider}`,
  );

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log(`\nInterventions suite: ${failed.length}/${results.length} checks FAILED`);
    process.exit(1);
  }

  console.log(`\nInterventions suite: ${results.length}/${results.length} checks PASSED`);
}

main().catch((err) => {
  console.error('Interventions suite crashed:', err);
  process.exit(1);
});

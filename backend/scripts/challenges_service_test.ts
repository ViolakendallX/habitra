import { prisma } from '../src/db/prisma.js';
import {
  evaluateChallengeProgress,
  evaluateChallengeProgressForUser,
  type ChallengeStatus,
  type EvaluateChallengeInput,
} from '../src/services/challenges.js';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}

function d(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00.000Z`);
}

function makeInput(overrides: Partial<EvaluateChallengeInput> = {}): EvaluateChallengeInput {
  return {
    challengeId: 'challenge-test',
    currentStatus: 'ACTIVE',
    startDate: d('2026-09-01'),
    endDate: d('2026-09-03'),
    durationDays: 3,
    maxMisses: 0,
    linkedHabits: [{ habitId: 'habit-1', name: 'Study', status: 'ACTIVE' }],
    completions: [],
    now: d('2026-09-02'),
    ...overrides,
  };
}

async function run(): Promise<void> {
  const createdUserIds: string[] = [];
  const createdChallengeIds: string[] = [];

  try {
    // 1) One-day challenge.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-05'),
        endDate: d('2026-09-05'),
        durationDays: 1,
        now: d('2026-09-05'),
      }));
      check('one-day challenge daysTotal=1', out.daysTotal === 1, `daysTotal=${out.daysTotal}`);
    }

    // 2) Multi-day challenge.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-30'),
        durationDays: 30,
        now: d('2026-09-05'),
      }));
      check('multi-day challenge daysTotal=30', out.daysTotal === 30, `daysTotal=${out.daysTotal}`);
      check('multi-day challenge daysElapsed=5', out.daysElapsed === 5, `daysElapsed=${out.daysElapsed}`);
    }

    // 3) Start date inclusive.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-01'),
      }));
      check('start date inclusive in elapsed count', out.daysElapsed === 1, `daysElapsed=${out.daysElapsed}`);
    }

    // 4) End date inclusive.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-03'),
      }));
      check('end date inclusive in elapsed count', out.daysElapsed === 3, `daysElapsed=${out.daysElapsed}`);
    }

    // 5) Today is pending (no row yet).
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-02'),
        completions: [{ date: d('2026-09-01'), status: 'COMPLETED' }],
      }));
      check('today with no row is pending', out.daysPending === 2, `pending=${out.daysPending}`);
      check('past completed day counted', out.daysCompleted === 1, `completed=${out.daysCompleted}`);
    }

    // 6) Future days are pending.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-04'),
        durationDays: 4,
        now: d('2026-09-01'),
      }));
      check('future days are pending', out.daysPending === 4, `pending=${out.daysPending}`);
    }

    // 7) Past missing day counts as missed.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-03'),
        completions: [{ date: d('2026-09-02'), status: 'COMPLETED' }],
      }));
      check('past missing day counted as missed', out.daysMissed === 1, `missed=${out.daysMissed}`);
    }

    // 8) Explicit MISSED completion.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-02'),
        durationDays: 2,
        now: d('2026-09-03'),
        maxMisses: 5,
        completions: [
          { date: d('2026-09-01'), status: 'MISSED' },
          { date: d('2026-09-02'), status: 'COMPLETED' },
        ],
      }));
      check('explicit MISSED completion counted', out.daysMissed === 1, `missed=${out.daysMissed}`);
    }

    // 9) Explicit COMPLETED completion.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-01'),
        durationDays: 1,
        now: d('2026-09-02'),
        completions: [{ date: d('2026-09-01'), status: 'COMPLETED' }],
      }));
      check('explicit COMPLETED completion counted', out.daysCompleted === 1, `completed=${out.daysCompleted}`);
    }

    // 10) maxMisses = 0.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-02'),
        durationDays: 2,
        now: d('2026-09-02'),
        maxMisses: 0,
        completions: [{ date: d('2026-09-01'), status: 'COMPLETED' }],
      }));
      check('maxMisses=0 with zero misses remains active', out.status === 'ACTIVE', `status=${out.status}`);
    }

    // 11) maxMisses > 0.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-03'),
        maxMisses: 1,
        completions: [{ date: d('2026-09-01'), status: 'COMPLETED' }],
      }));
      check('maxMisses>0 allows one miss', out.status === 'ACTIVE', `status=${out.status}`);
      check('remaining miss allowance computed', out.remainingMissAllowance === 0, `remaining=${out.remainingMissAllowance}`);
    }

    // 12) Failure when missed exceeds allowance.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-03'),
        maxMisses: 0,
        completions: [{ date: d('2026-09-01'), status: 'COMPLETED' }],
      }));
      check('failure when misses exceed allowance', out.status === 'FAILED', `status=${out.status}`);
      check('failure reason is deterministic', out.failureReason === 'MISSES_EXCEEDED:1>0', `reason=${out.failureReason}`);
    }

    // 13) Successful completion after end date.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        now: d('2026-09-04'),
        maxMisses: 0,
        completions: [
          { date: d('2026-09-01'), status: 'COMPLETED' },
          { date: d('2026-09-02'), status: 'COMPLETED' },
          { date: d('2026-09-03'), status: 'COMPLETED' },
        ],
      }));
      check('challenge completes after period end with no misses', out.status === 'COMPLETED', `status=${out.status}`);
    }

    // 14) Challenge still active before end date.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-10'),
        durationDays: 10,
        now: d('2026-09-05'),
        maxMisses: 1,
        completions: [
          { date: d('2026-09-01'), status: 'COMPLETED' },
          { date: d('2026-09-02'), status: 'MISSED' },
          { date: d('2026-09-03'), status: 'COMPLETED' },
          { date: d('2026-09-04'), status: 'COMPLETED' },
        ],
      }));
      check('active challenge remains ACTIVE before end date', out.status === 'ACTIVE', `status=${out.status}`);
    }

    // 15) DRAFT is not evaluated as ACTIVE.
    {
      const out = evaluateChallengeProgress(makeInput({
        currentStatus: 'DRAFT',
        startDate: d('2026-09-01'),
        endDate: d('2026-09-02'),
        durationDays: 2,
        now: d('2026-09-05'),
      }));
      check('DRAFT stays DRAFT and is not auto-activated', out.status === 'DRAFT', `status=${out.status}`);
    }

    // 16) UTC boundary behavior.
    {
      const out = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-01'),
        durationDays: 1,
        now: new Date('2026-09-01T23:59:59.999Z'),
      }));
      check('UTC boundary keeps same day pending before close', out.daysPending === 1, `pending=${out.daysPending}`);

      const outNext = evaluateChallengeProgress(makeInput({
        startDate: d('2026-09-01'),
        endDate: d('2026-09-01'),
        durationDays: 1,
        now: new Date('2026-09-02T00:00:00.000Z'),
      }));
      check('next UTC day closes previous day as missed', outNext.daysMissed === 1, `missed=${outNext.daysMissed}`);
    }

    // 17) Challenge linked to one habit (integration via DB).
    {
      const user = await prisma.user.create({
        data: {
          name: 'challenge-service-user',
          email: `challenge-svc-${Date.now()}@example.com`,
          passwordHash: 'hash',
        },
      });
      createdUserIds.push(user.id);

      const habit = await prisma.habit.create({
        data: {
          userId: user.id,
          name: 'Study',
          frequency: 'DAILY',
          target: 1,
          status: 'ACTIVE',
        },
      });

      const challenge = await prisma.challenge.create({
        data: {
          userId: user.id,
          title: '30-day study',
          status: 'ACTIVE',
          startDate: d('2026-09-01'),
          endDate: d('2026-09-03'),
          durationDays: 3,
          maxMisses: 1,
          committedAt: d('2026-09-01'),
        },
      });
      createdChallengeIds.push(challenge.id);

      await prisma.challengeHabit.create({
        data: {
          challengeId: challenge.id,
          habitId: habit.id,
        },
      });

      await prisma.habitCompletion.createMany({
        data: [
          { habitId: habit.id, userId: user.id, date: d('2026-09-01'), status: 'COMPLETED' },
          { habitId: habit.id, userId: user.id, date: d('2026-09-02'), status: 'COMPLETED' },
          { habitId: habit.id, userId: user.id, date: d('2026-09-03'), status: 'COMPLETED' },
        ],
      });

      const snapshot = await evaluateChallengeProgressForUser(user.id, challenge.id, d('2026-09-04'));

      check('integration snapshot exists for owned challenge', snapshot !== null);
      check(
        'integration snapshot includes linked habit info',
        snapshot?.linkedHabit?.habitId === habit.id && snapshot?.linkedHabit?.name === 'Study',
      );
      check('integration snapshot status evaluates to COMPLETED', snapshot?.status === 'COMPLETED', `status=${snapshot?.status}`);
      check('integration snapshot enforces one linked habit', snapshot?.linkedHabit !== null);
    }

    // 18) No challenge progress rows are created.
    {
      const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
        "select table_name from information_schema.tables where table_schema='public' and table_name ilike '%challenge%progress%'",
      );
      check('no challenge progress tables exist', rows.length === 0, `matches=${rows.map((r) => r.table_name).join(',')}`);
    }

    const failed = checks.filter((entry) => !entry.pass);
    if (failed.length > 0) {
      console.log(`\nChallenge service tests: ${failed.length}/${checks.length} checks FAILED`);
      process.exit(1);
    }

    console.log(`\nChallenge service tests: ${checks.length}/${checks.length} checks PASSED`);
  } finally {
    if (createdChallengeIds.length > 0) {
      await prisma.challenge.deleteMany({ where: { id: { in: createdChallengeIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  }
}

run().catch(async (err) => {
  console.error('Challenge service tests crashed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});

import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

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

function extractCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const first = setCookie.split(';')[0]?.trim();
  return first || null;
}

async function jsonOf(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function d(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00.000Z`);
}

async function registerAndLogin(base: string, name: string, email: string): Promise<string | null> {
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'Password123!' }),
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });

  return extractCookie(login.headers.get('set-cookie'));
}

async function createHabit(base: string, cookie: string | null, name: string): Promise<string | undefined> {
  const res = await fetch(`${base}/api/habits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      name,
      frequency: 'DAILY',
      target: 1,
    }),
  });

  const json = await jsonOf(res);
  return json?.data?.habit?.id;
}

async function run(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  let userAEmail = '';
  let userBEmail = '';
  let userAId: string | undefined;
  let userBId: string | undefined;

  try {
    userAEmail = `challenge-a-${Date.now()}@example.com`;
    userBEmail = `challenge-b-${Date.now()}@example.com`;

    const cookieA = await registerAndLogin(base, 'Challenge A', userAEmail);
    const cookieB = await registerAndLogin(base, 'Challenge B', userBEmail);

    check('authenticated session for user A created', typeof cookieA === 'string');
    check('authenticated session for user B created', typeof cookieB === 'string');

    const meA = await fetch(`${base}/api/auth/me`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const meAJson = await jsonOf(meA);
    userAId = meAJson?.data?.user?.id as string | undefined;

    const meB = await fetch(`${base}/api/auth/me`, {
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    const meBJson = await jsonOf(meB);
    userBId = meBJson?.data?.user?.id as string | undefined;

    check('auth/me returns user A id', typeof userAId === 'string');
    check('auth/me returns user B id', typeof userBId === 'string');

    if (!userAId || !userBId) {
      throw new Error('Failed to resolve authenticated user ids for test setup.');
    }

    const habitAId = await createHabit(base, cookieA, 'Study Habit A');
    check('habit A created for challenge tests', typeof habitAId === 'string');

    const habitA2Id = await createHabit(base, cookieA, 'Study Habit A2');
    check('habit A2 created for challenge tests', typeof habitA2Id === 'string');

    const habitBId = await createHabit(base, cookieB, 'Study Habit B');
    check('habit B created for challenge tests', typeof habitBId === 'string');

    if (!habitAId || !habitA2Id || !habitBId) {
      throw new Error('Habit setup failed for challenge API tests.');
    }

    // -------- Existing 6C coverage --------

    const postNoAuth = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'No auth challenge',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        habitId: habitAId,
      }),
    });
    check('unauthenticated create is rejected', postNoAuth.status === 401, `status=${postNoAuth.status}`);

    const listNoAuth = await fetch(`${base}/api/challenges`);
    check('unauthenticated list is rejected', listNoAuth.status === 401, `status=${listNoAuth.status}`);

    const viewNoAuth = await fetch(`${base}/api/challenges/does-not-matter`);
    check('unauthenticated view is rejected', viewNoAuth.status === 401, `status=${viewNoAuth.status}`);

    const missingRequired = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({ title: '' }),
    });
    check('missing required fields returns 400', missingRequired.status === 400, `status=${missingRequired.status}`);

    const invalidDates = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({
        title: 'Invalid date challenge',
        startDate: '2026-02-30',
        endDate: '2026-09-03',
        habitId: habitAId,
      }),
    });
    check('invalid calendar date is rejected', invalidDates.status === 400, `status=${invalidDates.status}`);

    const badRange = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({
        title: 'Bad range',
        startDate: '2026-09-05',
        endDate: '2026-09-01',
        habitId: habitAId,
      }),
    });
    check('startDate after endDate is rejected', badRange.status === 400, `status=${badRange.status}`);

    const badMisses = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({
        title: 'Negative misses',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        maxMisses: -1,
        habitId: habitAId,
      }),
    });
    check('negative maxMisses is rejected', badMisses.status === 400, `status=${badMisses.status}`);

    const crossUserHabit = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({
        title: 'Try link user B habit',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        habitId: habitBId,
      }),
    });
    check('cross-user habit linking returns generic 404', crossUserHabit.status === 404, `status=${crossUserHabit.status}`);

    const createChallenge = await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({
        title: '30-Day Study Challenge',
        description: 'Study every day',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        maxMisses: 2,
        habitId: habitAId,
        userId: userBId,
        durationDays: 999,
        status: 'ACTIVE',
      }),
    });
    const createJson = await jsonOf(createChallenge);
    const challenge = createJson?.data?.challenge;
    const challengeId = challenge?.id as string | undefined;

    check('authenticated creation succeeds', createChallenge.status === 201 && typeof challengeId === 'string', `status=${createChallenge.status}`);
    check('DRAFT is always initial status', challenge?.status === 'DRAFT', `status=${challenge?.status}`);
    check('client userId override is ignored', challenge?.userId === userAId, `userId=${challenge?.userId}`);
    check('client durationDays override is ignored', challenge?.durationDays === 30, `durationDays=${challenge?.durationDays}`);
    check('computed progress is returned on create', typeof challenge?.progress?.daysTotal === 'number');
    check('linked habit info is returned on create', challenge?.linkedHabit?.habitId === habitAId);

    if (!challengeId) {
      throw new Error('Primary challenge creation failed; cannot continue tests.');
    }

    const listARes = await fetch(`${base}/api/challenges`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const listAJson = await jsonOf(listARes);
    const listA = listAJson?.data?.challenges ?? [];
    check('list for user A succeeds', listARes.status === 200, `status=${listARes.status}`);
    check('list only returns authenticated user challenges', Array.isArray(listA) && listA.every((item: any) => item.userId === userAId));
    check('list includes computed progress snapshot', Array.isArray(listA) && listA.every((item: any) => item.progress && typeof item.progress.daysTotal === 'number'));

    const listBRes = await fetch(`${base}/api/challenges`, {
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    const listBJson = await jsonOf(listBRes);
    const listB = listBJson?.data?.challenges ?? [];
    check('list for user B succeeds', listBRes.status === 200, `status=${listBRes.status}`);
    check('cross-user challenge isolation in list', Array.isArray(listB) && listB.every((item: any) => item.userId === userBId) && !listB.some((item: any) => item.id === challengeId));

    const viewARes = await fetch(`${base}/api/challenges/${challengeId}`, {
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const viewAJson = await jsonOf(viewARes);
    check('owner can view challenge', viewARes.status === 200, `status=${viewARes.status}`);
    check('view includes computed progress snapshot', typeof viewAJson?.data?.challenge?.progress?.daysTotal === 'number');

    const viewBRes = await fetch(`${base}/api/challenges/${challengeId}`, {
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    check('view cannot access another user challenge', viewBRes.status === 404, `status=${viewBRes.status}`);

    // -------- 6D COMMIT tests --------

    // 1,2,3,11,12
    const commitRes = await fetch(`${base}/api/challenges/${challengeId}/commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({ userId: userBId }),
    });
    const commitJson = await jsonOf(commitRes);
    const committed = commitJson?.data?.challenge;
    check('authenticated DRAFT -> ACTIVE commit succeeds', commitRes.status === 200 && committed?.status === 'ACTIVE', `status=${commitRes.status}/${committed?.status}`);
    check('committedAt populated on commit', Boolean(committed?.committedAt));
    check('completedAt and failedAt remain null on commit', committed?.completedAt === null && committed?.failedAt === null);
    check('commit ignores client userId override payload', committed?.userId === userAId, `userId=${committed?.userId}`);
    check('commit preserves challenge title/description/dates', committed?.title === '30-Day Study Challenge' && committed?.description === 'Study every day' && String(committed?.startDate).startsWith('2026-09-01'));

    // 4
    const commitNoAuth = await fetch(`${base}/api/challenges/${challengeId}/commit`, { method: 'POST' });
    check('unauthenticated commit is rejected', commitNoAuth.status === 401, `status=${commitNoAuth.status}`);

    // 5
    const commitCrossUser = await fetch(`${base}/api/challenges/${challengeId}/commit`, {
      method: 'POST',
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    check('cross-user commit access is blocked', commitCrossUser.status === 404, `status=${commitCrossUser.status}`);

    // 6 recommit ACTIVE rejected
    const recommitActive = await fetch(`${base}/api/challenges/${challengeId}/commit`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    check('recommit ACTIVE challenge is rejected', recommitActive.status === 409, `status=${recommitActive.status}`);

    // Create special status challenges directly for commit-state tests
    const completedChallenge = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Completed state challenge',
        status: 'COMPLETED',
        startDate: d('2026-08-01'),
        endDate: d('2026-08-03'),
        durationDays: 3,
        maxMisses: 0,
        committedAt: d('2026-08-01'),
        completedAt: d('2026-08-04'),
      },
    });
    await prisma.challengeHabit.create({
      data: {
        challengeId: completedChallenge.id,
        habitId: habitAId,
      },
    });

    const failedChallenge = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Failed state challenge',
        status: 'FAILED',
        startDate: d('2026-08-01'),
        endDate: d('2026-08-03'),
        durationDays: 3,
        maxMisses: 0,
        committedAt: d('2026-08-01'),
        failedAt: d('2026-08-02'),
        failReason: 'MISSES_EXCEEDED:1>0',
      },
    });
    await prisma.challengeHabit.create({
      data: {
        challengeId: failedChallenge.id,
        habitId: habitAId,
      },
    });

    const archivedChallenge = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Archived state challenge',
        status: 'ARCHIVED',
        startDate: d('2026-08-01'),
        endDate: d('2026-08-03'),
        durationDays: 3,
        maxMisses: 0,
        committedAt: d('2026-08-01'),
      },
    });
    await prisma.challengeHabit.create({
      data: {
        challengeId: archivedChallenge.id,
        habitId: habitAId,
      },
    });

    const commitCompleted = await fetch(`${base}/api/challenges/${completedChallenge.id}/commit`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    check('commit COMPLETED challenge is rejected', commitCompleted.status === 409, `status=${commitCompleted.status}`);

    const commitFailed = await fetch(`${base}/api/challenges/${failedChallenge.id}/commit`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    check('commit FAILED challenge is rejected', commitFailed.status === 409, `status=${commitFailed.status}`);

    const commitArchived = await fetch(`${base}/api/challenges/${archivedChallenge.id}/commit`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    check('commit ARCHIVED challenge is rejected', commitArchived.status === 409, `status=${commitArchived.status}`);

    // 10 invalid linked habit count
    const invalidLinkChallenge = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Invalid linked habit count',
        status: 'DRAFT',
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        maxMisses: 0,
      },
    });
    await prisma.challengeHabit.create({
      data: { challengeId: invalidLinkChallenge.id, habitId: habitAId },
    });
    await prisma.challengeHabit.create({
      data: { challengeId: invalidLinkChallenge.id, habitId: habitA2Id },
    });

    const invalidLinkCommit = await fetch(`${base}/api/challenges/${invalidLinkChallenge.id}/commit`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    check('commit rejects invalid linked habit count', invalidLinkCommit.status === 409, `status=${invalidLinkCommit.status}`);

    // -------- 6D EVALUATE tests --------

    // 13 ACTIVE no missed days remains ACTIVE before end
    const activeSafe = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Active safe challenge',
        status: 'ACTIVE',
        startDate: d('2026-09-01'),
        endDate: d('2099-09-30'),
        durationDays: 26694,
        maxMisses: 100000,
        committedAt: d('2026-09-01'),
      },
    });
    await prisma.challengeHabit.create({
      data: { challengeId: activeSafe.id, habitId: habitAId },
    });

    const evalActiveSafe = await fetch(`${base}/api/challenges/${activeSafe.id}/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieA ? { Cookie: cookieA } : {}),
      },
      body: JSON.stringify({ userId: userBId }),
    });
    const evalActiveSafeJson = await jsonOf(evalActiveSafe);
    check('ACTIVE challenge remains ACTIVE before end with allowance', evalActiveSafeJson?.data?.challenge?.status === 'ACTIVE', `status=${evalActiveSafeJson?.data?.challenge?.status}`);

    // 14,15,16 ACTIVE exceeding maxMisses -> FAILED with failedAt/failReason
    const activeFail = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Active fail challenge',
        status: 'ACTIVE',
        startDate: d('2026-09-01'),
        endDate: d('2026-09-03'),
        durationDays: 3,
        maxMisses: 0,
        committedAt: d('2026-09-01'),
      },
    });
    await prisma.challengeHabit.create({
      data: { challengeId: activeFail.id, habitId: habitAId },
    });

    await prisma.habitCompletion.create({
      data: {
        habitId: habitAId,
        userId: userAId,
        date: d('2026-09-01'),
        status: 'COMPLETED',
      },
    });

    const evalFailRes = await fetch(`${base}/api/challenges/${activeFail.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalFailJson = await jsonOf(evalFailRes);
    const evalFailChallenge = evalFailJson?.data?.challenge;
    check('ACTIVE challenge exceeding maxMisses becomes FAILED', evalFailChallenge?.status === 'FAILED', `status=${evalFailChallenge?.status}`);
    check('failedAt populated on failure transition', Boolean(evalFailChallenge?.failedAt));
    check('deterministic failReason is stored', typeof evalFailChallenge?.failReason === 'string' && evalFailChallenge.failReason.startsWith('MISSES_EXCEEDED:'), `reason=${evalFailChallenge?.failReason}`);

    // 17,18,19 completion path and timestamp mix rules
    const activeComplete = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Active complete challenge',
        status: 'ACTIVE',
        startDate: d('2026-01-01'),
        endDate: d('2026-01-02'),
        durationDays: 2,
        maxMisses: 0,
        committedAt: d('2026-01-01'),
      },
    });
    await prisma.challengeHabit.create({
      data: { challengeId: activeComplete.id, habitId: habitAId },
    });
    await prisma.habitCompletion.createMany({
      data: [
        { habitId: habitAId, userId: userAId, date: d('2026-01-01'), status: 'COMPLETED' },
        { habitId: habitAId, userId: userAId, date: d('2026-01-02'), status: 'COMPLETED' },
      ],
      skipDuplicates: true,
    });

    const evalCompleteRes = await fetch(`${base}/api/challenges/${activeComplete.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalCompleteJson = await jsonOf(evalCompleteRes);
    const evalCompleteChallenge = evalCompleteJson?.data?.challenge;
    check('ACTIVE challenge after end can become COMPLETED', evalCompleteChallenge?.status === 'COMPLETED', `status=${evalCompleteChallenge?.status}`);
    check('completedAt populated on completion transition', Boolean(evalCompleteChallenge?.completedAt));
    check('completion/failure timestamps are not mixed', evalCompleteChallenge?.failedAt === null && evalCompleteChallenge?.failReason === null);

    // 20 DRAFT remains DRAFT
    const draftEval = await fetch(`${base}/api/challenges/${invalidLinkChallenge.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const draftEvalJson = await jsonOf(draftEval);
    check('DRAFT remains DRAFT on evaluate', draftEvalJson?.data?.challenge?.status === 'DRAFT', `status=${draftEvalJson?.data?.challenge?.status}`);

    // 21,22,23 terminal states remain
    const evalCompletedAgain = await fetch(`${base}/api/challenges/${completedChallenge.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalCompletedAgainJson = await jsonOf(evalCompletedAgain);
    check('terminal COMPLETED remains COMPLETED', evalCompletedAgainJson?.data?.challenge?.status === 'COMPLETED', `status=${evalCompletedAgainJson?.data?.challenge?.status}`);

    const evalFailedAgain = await fetch(`${base}/api/challenges/${failedChallenge.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalFailedAgainJson = await jsonOf(evalFailedAgain);
    check('terminal FAILED remains FAILED', evalFailedAgainJson?.data?.challenge?.status === 'FAILED', `status=${evalFailedAgainJson?.data?.challenge?.status}`);

    const evalArchivedAgain = await fetch(`${base}/api/challenges/${archivedChallenge.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalArchivedAgainJson = await jsonOf(evalArchivedAgain);
    check('terminal ARCHIVED remains ARCHIVED', evalArchivedAgainJson?.data?.challenge?.status === 'ARCHIVED', `status=${evalArchivedAgainJson?.data?.challenge?.status}`);

    // 24 repeated evaluation idempotent
    const firstRepeat = await fetch(`${base}/api/challenges/${activeComplete.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const firstRepeatJson = await jsonOf(firstRepeat);
    const completedAtBefore = firstRepeatJson?.data?.challenge?.completedAt;

    const secondRepeat = await fetch(`${base}/api/challenges/${activeComplete.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const secondRepeatJson = await jsonOf(secondRepeat);
    const completedAtAfter = secondRepeatJson?.data?.challenge?.completedAt;
    check('repeated evaluate is idempotent for terminal state', completedAtBefore === completedAtAfter);

    // 25 cross-user isolation for evaluate
    const evalCrossUser = await fetch(`${base}/api/challenges/${activeSafe.id}/evaluate`, {
      method: 'POST',
      headers: cookieB ? { Cookie: cookieB } : {},
    });
    check('cross-user evaluate access is blocked', evalCrossUser.status === 404, `status=${evalCrossUser.status}`);

    // 26 client userId override on evaluate ignored (already in evalActiveSafe with body)
    check('evaluate response still belongs to authenticated owner', evalActiveSafeJson?.data?.challenge?.userId === userAId, `userId=${evalActiveSafeJson?.data?.challenge?.userId}`);

    // date boundary behavior
    const todayIso = new Date().toISOString().slice(0, 10);
    const endingToday = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Ends today challenge',
        status: 'ACTIVE',
        startDate: d('2026-01-01'),
        endDate: d(todayIso),
        durationDays: Math.round((d(todayIso).getTime() - d('2026-01-01').getTime()) / (24 * 60 * 60 * 1000)) + 1,
        maxMisses: 999999,
        committedAt: d('2026-01-01'),
      },
    });
    await prisma.challengeHabit.create({ data: { challengeId: endingToday.id, habitId: habitAId } });

    const evalEndingToday = await fetch(`${base}/api/challenges/${endingToday.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalEndingTodayJson = await jsonOf(evalEndingToday);
    check('challenge ending today remains ACTIVE until day closes', evalEndingTodayJson?.data?.challenge?.status === 'ACTIVE', `status=${evalEndingTodayJson?.data?.challenge?.status}`);

    const endingYesterday = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Ended yesterday challenge',
        status: 'ACTIVE',
        startDate: d('2001-01-01'),
        endDate: d('2001-01-02'),
        durationDays: 2,
        maxMisses: 0,
        committedAt: d('2001-01-01'),
      },
    });
    await prisma.challengeHabit.create({ data: { challengeId: endingYesterday.id, habitId: habitAId } });

    await prisma.habitCompletion.createMany({
      data: [
        { habitId: habitAId, userId: userAId, date: d('2001-01-01'), status: 'COMPLETED' },
        { habitId: habitAId, userId: userAId, date: d('2001-01-02'), status: 'COMPLETED' },
      ],
      skipDuplicates: true,
    });

    const evalEndingYesterday = await fetch(`${base}/api/challenges/${endingYesterday.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalEndingYesterdayJson = await jsonOf(evalEndingYesterday);
    check('challenge ending yesterday can complete on evaluate', evalEndingYesterdayJson?.data?.challenge?.status === 'COMPLETED', `status=${evalEndingYesterdayJson?.data?.challenge?.status}`);

    const startsTodayIso = new Date().toISOString().slice(0, 10);
    const startingToday = await prisma.challenge.create({
      data: {
        userId: userAId,
        title: 'Starting today challenge',
        status: 'ACTIVE',
        startDate: d(startsTodayIso),
        endDate: d(startsTodayIso),
        durationDays: 1,
        maxMisses: 0,
        committedAt: d(startsTodayIso),
      },
    });
    await prisma.challengeHabit.create({ data: { challengeId: startingToday.id, habitId: habitAId } });

    const evalStartingToday = await fetch(`${base}/api/challenges/${startingToday.id}/evaluate`, {
      method: 'POST',
      headers: cookieA ? { Cookie: cookieA } : {},
    });
    const evalStartingTodayJson = await jsonOf(evalStartingToday);
    check('challenge starting today remains ACTIVE during open UTC day', evalStartingTodayJson?.data?.challenge?.status === 'ACTIVE', `status=${evalStartingTodayJson?.data?.challenge?.status}`);

    // 27 progress is not persisted
    const progressTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      "select table_name from information_schema.tables where table_schema='public' and table_name ilike '%challenge%progress%'",
    );
    check('no challenge progress table exists', progressTables.length === 0, `matches=${progressTables.map((row) => row.table_name).join(',')}`);
  } finally {
    server.close();

    const userIds = [userAId, userBId].filter((id): id is string => Boolean(id));
    if (userIds.length > 0) {
      await prisma.challenge.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } else {
      const emails = [userAEmail, userBEmail].filter(Boolean);
      if (emails.length > 0) {
        const users = await prisma.user.findMany({
          where: { email: { in: emails } },
          select: { id: true },
        });
        const fallbackIds = users.map((user) => user.id);
        if (fallbackIds.length > 0) {
          await prisma.challenge.deleteMany({ where: { userId: { in: fallbackIds } } });
          await prisma.user.deleteMany({ where: { id: { in: fallbackIds } } });
        }
      }
    }

    await prisma.$disconnect();
  }

  const failed = checks.filter((item) => !item.pass);
  if (failed.length > 0) {
    console.log(`\nChallenge API suite: ${failed.length}/${checks.length} checks FAILED`);
    process.exit(1);
  }

  console.log(`\nChallenge API suite: ${checks.length}/${checks.length} checks PASSED`);
}

run().catch(async (err) => {
  console.error('Challenge API suite crashed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});

import { prisma } from '../src/db/prisma.js';
import { accountabilityAgentService, geminiModelName } from '../src/services/agent.js';
import { env } from '../src/config/env.js';

async function main(): Promise<void> {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is missing; cannot run smoke test.');
  }

  const email = `agent-smoke-${Date.now()}@example.com`;
  const user = await prisma.user.create({
    data: {
      name: 'agent-smoke-user',
      email,
      passwordHash: 'smoke-hash',
    },
  });

  try {
    const habit = await prisma.habit.create({
      data: {
        userId: user.id,
        name: 'Drink water',
        frequency: 'DAILY',
        target: 1,
        preferredTime: '09:00',
        status: 'ACTIVE',
      },
    });

    await prisma.habitCompletion.create({
      data: {
        habitId: habit.id,
        userId: user.id,
        date: new Date('2026-09-06T00:00:00.000Z'),
        status: 'COMPLETED',
        missReason: null,
      },
    });

    const result = await accountabilityAgentService.generateRecommendation(user.id);

    if (!result.message || !result.recommendation || !result.reason) {
      throw new Error('Agent returned empty content in smoke test.');
    }

    console.log('AGENT_SMOKE_OK');
    console.log(`model=${geminiModelName}`);
    console.log(`memoryUsed=${result.memoryUsed}`);
    console.log(`message=${result.message.slice(0, 160)}`);
    console.log(`recommendation=${result.recommendation.slice(0, 160)}`);
    console.log(`reason=${result.reason.slice(0, 160)}`);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('AGENT_SMOKE_FAIL:', err instanceof Error ? err.message : String(err));
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});

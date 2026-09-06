-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "maxMisses" INTEGER NOT NULL DEFAULT 0,
    "committedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeHabit" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "habitId" TEXT NOT NULL,

    CONSTRAINT "ChallengeHabit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Challenge_userId_status_idx" ON "Challenge"("userId", "status");

-- CreateIndex
CREATE INDEX "Challenge_userId_startDate_endDate_idx" ON "Challenge"("userId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "ChallengeHabit_habitId_idx" ON "ChallengeHabit"("habitId");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeHabit_challengeId_habitId_key" ON "ChallengeHabit"("challengeId", "habitId");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeHabit" ADD CONSTRAINT "ChallengeHabit_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeHabit" ADD CONSTRAINT "ChallengeHabit_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "Habit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


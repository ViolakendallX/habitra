# Habitra

**Autonomous accountability that remembers.**

Habitra is a habit-accountability system that does not just log what you did. It
remembers *how* you behave, reasons about why you slip, recommends a concrete
next step, and lets you put a real on-chain stake behind your commitment.

Most habit trackers are stateless: every day starts from zero, and every
recommendation is generic. Habitra is built around a persistent behavioural
memory, so the system can say *"you miss 'reading' most often at 08:00 and you
cite fatigue — shorten the session"* instead of *"try to read more"*.

---

## The core loop

```
Track → Remember → Understand → Recommend → Commit → Reward → Learn
```

| Step | What happens | Where it lives |
| --- | --- | --- |
| **Track** | The user records daily habit completions and misses. | PostgreSQL (`Habit`, `HabitCompletion`) |
| **Remember** | Each completion/miss is written to Sibyl Memory as a behavioural event, and a per-habit behavioural profile is maintained. | Sibyl Memory (see below) |
| **Understand** | Analytics are computed and Sibyl is searched for behavioural history and prior recommendation outcomes. | `services/analytics.ts`, `services/agent.ts` |
| **Recommend** | Gemini receives the combined context and returns one recommendation, plus a decision on whether an intervention is needed. | `services/agent.ts` |
| **Commit** | The user opens a challenge and locks a BEES stake into the escrow on Base Sepolia. | `services/challenges.ts`, `HabitraChallengeEscrow.sol` |
| **Reward** | On pass the stake is returned; on fail it is slashed to the treasury. *Settlement is implemented and unit-tested but has not yet been executed on-chain — see [Base](#base-on-chain-layer).* | `HabitraChallengeEscrow.sol` |
| **Learn** | The user records whether the recommendation was accepted and helpful; that outcome is merged back into Sibyl and changes the next recommendation. | `routes/agent.ts`, `services/virtuals.ts` |

---

## Architecture

Each partner technology has one job. The layers are deliberately kept separate —
no layer re-decides what another layer has already decided.

| Layer | Role | Technology |
| --- | --- | --- |
| **Habitra** | The accountability product: habits, challenges, analytics, web app, and the off-chain evaluator that decides pass/fail. | Node/Express + React + PostgreSQL |
| **Sibyl** | **Memory.** Stores behavioural events, per-habit profiles, and recommendation outcomes across sessions. | Sibyl Memory (SQLite-backed, per-user tenant) |
| **Gemini** | **Reasoning.** The only decision-maker for *what* to recommend and *whether* to intervene. | Google Gemini |
| **Virtuals** | **Intervention / coordination.** Transports an already-decided intervention across ACP v2 as a priced job between two agents. | Virtuals ACP v2 |
| **Base** | **On-chain economic consequence.** Custodies the staked BEES and executes return-or-slash. | Base Sepolia (84532), Solidity |

The trust boundary is explicit: **the chain enforces the consequence, not the
judgement.** Habit performance data lives off-chain, so Habitra's evaluator
decides pass/fail and the escrow contract only executes the resulting transfer.

---

## Why Sibyl Memory Is Load-Bearing

Sibyl is not a logging sidecar or a nice-to-have cache. It is the subsystem that
makes Habitra's recommendations *specific to a person over time*. Removing or
bypassing it would materially degrade the core accountability loop.

### Every memory write

| What is stored | Sibyl operation | Call site |
| --- | --- | --- |
| Habit completion / miss event (COLD tier) | `write_event` | `backend/src/routes/habits.ts:557` — `recordCompletionEvent` |
| Per-habit behavioural profile: best time of day, cadence, common miss reasons (WARM entity, `habit_behavior`) | `set_entity` | `backend/src/routes/habits.ts:566` — `saveHabitBehaviorProfile` |
| The recommendation the agent just produced (WARM entity, `recommendation`) | `set_entity` | `backend/src/services/agent.ts:566-573` — `saveRecommendationOutcome` |
| Whether the user accepted / found helpful — merged into the *same* entity so history is preserved | `get_entity` + `set_entity` | `backend/src/routes/agent.ts:97` — `recordRecommendationOutcome` |
| The outcome of a Virtuals-delivered intervention, under a distinct `source` | `set_entity` | `backend/src/services/virtuals.ts:699` |

### Every memory read that shapes the model

| What is retrieved | Call site |
| --- | --- |
| Behavioural profiles and prior recommendation outcomes, searched per habit name | `backend/src/services/agent.ts:474-475` — `searchMemories` |
| Retrieved memory folded into the agent context (`memory.habitBehavior`, `memory.priorRecommendations`, `memoryUsed`) | `backend/src/services/agent.ts:458` and `backend/src/services/agent.ts:515-521` |

That context is passed to `buildPrompt(context)` and sent to Gemini. **The
retrieved memory is therefore an input to the model, not an afterthought.**

### What is actually lost without Sibyl

If Sibyl is removed or bypassed, the agent loses:

- **Behavioural history** — the accumulated record of what this user actually did, not just the last few days in Postgres.
- **Best-time-of-day patterns** — e.g. "this user completes at 08:00 and slips at 19:00".
- **Common miss reasons** — the stated causes ("too tired", "no time"), which are what make a recommendation actionable rather than generic.
- **Prior recommendation outcomes** — what was already suggested, whether it was accepted, and whether it helped.

Without those, every recommendation collapses to a generic restatement of the
current week's numbers, the system repeats advice the user already declined, and
the **Learn** step of the loop cannot exist at all — there is nowhere for an
outcome to be recorded, so the loop never improves. That is a material
degradation of the core accountability function, not a cosmetic one.

### Fresh-session recall (the demo flow)

1. In one session, complete and miss habits. Each write goes to Sibyl.
2. Start a **fresh session** (new agent request, no in-memory state).
3. The agent searches Sibyl by habit name and pulls back the behavioural profile and prior recommendations.
4. Gemini produces a recommendation that references that history.
5. Record accept / helpful; it merges back into the same Sibyl entity and changes the next recommendation.

Sibyl is enabled by default (`SIBYL_ENABLED` is opt-*out*) and is failure-safe by
design: a memory outage is logged and swallowed so it can never break a request.
Every memory function refuses to store anything that looks like a credential.

---

## Base on-chain layer

> **Status: deployed and verified live on Base Sepolia. Settlement has NOT occurred.**

Two contracts are deployed and independently verified against a live Base
Sepolia RPC. Chain id `0x14a34` = **84532**.

| Contract | Address |
| --- | --- |
| **BEES** (ERC-20, "Habitra BEES", 18 dp) | `0x43e67b33248e3262fe12d3ae826850936a2d1cd9` |
| **HabitraChallengeEscrow** | `0x3211fe09b5ad90a40d4a21f779d07c1a7e0c3c4f` |

BEES is a demo token with no market value, no liquidity and no mainnet
deployment; it exists so the accountability loop can be exercised with real EVM
semantics while risking nothing of value.

### Verified on-chain activity

Exactly three transactions have ever touched this deployment. All values below
were read from Base Sepolia.

| Step | Transaction | Detail |
| --- | --- | --- |
| **Mint** | `0xf473926151989e969ec542fbef218a8fcec0297ee1f77457817df77e28a52870` | 5 BEES minted to the demo user `0xB340a31D33D361CC9809B3C8D26D03F088A2e20e` |
| **Approve** | `0x570c29f958ef75ec19d60fcc09b8772c66dd4bb6b2c97911b9d10329efbd73ec` | Block **46581162** — user approves the escrow to pull 5 BEES |
| **Lock** | `0x7bafb7c21c9e7c0a8d26a04fca1385c944b625c63363d1c2854ba5a88efb91c3` | Block **46581419** — `lock()` (selector `0x57b2d76f`), status **success** |

**5 BEES were locked and the lock is live on Base Sepolia.** The escrow currently
custodies the full 5 BEES; the user's BEES balance and remaining allowance are
both 0.

On-chain commitment state (commitment id `1`):

| Field | Value |
| --- | --- |
| `user` | `0xB340a31D33D361CC9809B3C8D26D03F088A2e20e` |
| `amount` | 5 BEES |
| `endsAt` | `2026-09-15T00:00:00Z` |
| `settled` | **`false`** |
| `succeeded` | `false` |
| `isPending` | **`true`** |

### Off-chain reconciliation

The backend mirrors the lock into the `Transaction` table and reconciles it
against the chain. The confirmed row is:

- id `cmttmscea0002bsl4dtxx5pyv`, type `FUND`, status **CONFIRMED**, amount 5 BEES, txHash `0x7bafb7c21c9e7c0a8d26a04fca1385c944b625c63363d1c2854ba5a88efb91c3`

### What we do NOT claim

- **No settlement has occurred.** `settled` is `false` and `isPending` is `true`.
- **No reward has been paid and no penalty has been slashed.** `settle()` has never been executed on-chain.
- Settlement is implemented and covered by contract tests (13 escrow tests, all passing), but it has not been run against the live deployment.

---

## Virtuals ACP v2 integration

Habitra uses Virtuals ACP v2 as the transport for the intervention step. The
layering is strict: **Gemini decides whether an intervention is needed, and
Virtuals moves that already-decided intervention** — the ACP layer never
inspects habits or memories to decide anything.

### Topology

ACP v2 requires the buyer and seller to use **different wallets**:

- **Seller** — the registered Habitra agent that owns the `accountabilityIntervention` offering and fulfils jobs.
- **Buyer** — a separate Habitra-owned agent that creates and funds jobs.

### Offering and job lifecycle

- Offering: `accountabilityIntervention`, fixed price `0.01` USDC.
- Seller-side job flow (`backend/src/services/virtualsProvider.ts`):
  1. `job.created` → provider responds
  2. requirement message carrying `{"habitContext": "..."}`
  3. `setBudget(0.01 USDC)`
  4. `job.funded` → provider responds
  5. `submit(<Gemini-authored intervention text>)`
  6. skip-evaluation → `job.completed`

The provider is a singleton: `AcpAgent.start()` opens an SSE stream and the SDK
stores exactly one handler, so the seller agent is created once and reused.
If a deliverable cannot be produced the provider does **not** submit junk — it
logs a reason code and lets the job expire, which refunds the client.

### What was exercised

- `@virtuals-protocol/acp-node-v2` (v0.1.12) is a real dependency and is loaded.
- All seller and buyer wallet / signer configuration is present and validated.
- Offline test suites pass and cover config selection, credential validation, and the exact arguments the real job-creation call would send:
  - `npm run test:virtuals_intervention` — 33/33
  - `npm run test:virtuals_acp_v2` — 27/27
  - `npm run test:virtuals_provider` — 47/47

### ⚠️ Current limitation — no completed live ACP job

**The external Virtuals signing relay was unavailable, so there was no completed
live ACP job.** The integration is complete and will transact once the relay is
reachable, but we explicitly do **not** claim:

- a completed ACP job,
- a production ACP transaction, or
- a successful live Virtuals settlement.

The offline suites stub the buyer agent and make **no network calls**; they prove
configuration and argument construction, not a live job. The local mock client is
demo-only.

---

## Partner stacks

### 1. Sibyl Memory

- **Implemented:** typed memory service with writes for completion events, per-habit behavioural profiles, recommendation outcomes and intervention outcomes; reads by category and full-text search; per-user tenant isolation; secret refusal; hard timeout and failure-safe degradation.
- **Exercised:** a populated local store with real behavioural profiles and prior recommendation entities; live recall verified; `test:sibyl`, `test:habit_memory` and `test:learning_loop` all pass.
- **Demonstrable:** the full fresh-session recall flow — miss a habit, start a new session, and watch the recommendation change because Sibyl remembered.

### 2. Base

- **Implemented:** BEES ERC-20 and `HabitraChallengeEscrow` (lock → settle), both deployed to Base Sepolia; backend escrow service; wallet linkage; on-chain confirmation and reconciliation.
- **Exercised:** mint, approve and a real `lock()` transaction (5 BEES) on Base Sepolia 84532, reconciled off-chain to a `CONFIRMED` `FUND` row; 16/16 contract tests pass.
- **Demonstrable:** live contract reads, the three transaction hashes, escrow custody of the stake, and the off-chain reconciliation record. **Settlement is not demonstrated because it has not happened.**

### 3. Virtuals ACP v2

- **Implemented:** seller/buyer two-wallet topology, `accountabilityIntervention` offering, job lifecycle handling, singleton provider/listener, budget handling, and expiry-based failure policy.
- **Exercised:** offline boundary and adapter tests (33/33, 27/27, 47/47) covering config selection, credential validation and job-creation arguments.
- **Demonstrable:** the integration code and its offline test coverage. **A live job is not demonstrable** — the external signing relay was unavailable.

---

## Repository layout

```
habitra/
├── backend/     Node + Express + TypeScript API, Prisma/PostgreSQL, agent, Sibyl bridge, escrow service
├── frontend/    React + Vite + TypeScript app (Dashboard, Habits, Challenges, Agent, Wallet, Settings)
├── contracts/   Solidity (BEES, HabitraChallengeEscrow), Hardhat tests, deploy + ABI export scripts
├── PRD.md       Product requirements document
└── LICENSE      MIT
```

Backend routes: `auth`, `habits`, `analytics`, `agent`, `challenges`, `wallet`,
`blockchain`, `passwordReset`, `health`.

---

## Getting started

Requirements: Node.js 20.19+ (developed on Node 22), PostgreSQL.

```bash
# Backend
cd backend
npm install
cp .env.example .env      # then fill in DATABASE_URL, JWT_SECRET, GEMINI_API_KEY
npm run dev               # http://localhost:4000

# Frontend
cd frontend
npm install
npm run dev               # http://localhost:5173

# Contracts
cd contracts
npm install
npm run compile
npm test
```

`.env` is optional for the backend — scripts use `--env-file-if-exists`. Sibyl
Memory is enabled by default and requires the project virtualenv with
`sibyl-memory-client` installed; see `backend/.env.example`.

---

## Testing

```bash
cd backend
npm run typecheck
npm run test:challenges_service && npm run test:challenges_api
npm run test:regression_api && npm run test:wallet_api
npm run test:blockchain_persistence && npm run test:challenge_escrow_confirm
npm run test:agent && npm run test:sibyl && npm run test:habit_memory
npm run test:learning_loop
npm run test:virtuals_intervention && npm run test:virtuals_acp_v2 && npm run test:virtuals_provider

cd ../contracts && npm test
cd ../frontend && npm run build
```

Note: `npm run test:challenge_escrow` asserts `DEMO_CHAIN_MODE=true`. It fails
under a live configuration (`DEMO_CHAIN_MODE=false`) because the demo-only
simulation assertions cannot hold. Run it with `DEMO_CHAIN_MODE=true`, or rely on
`test:challenge_escrow_confirm`, which exercises the live path and passes 48/48.

---

## Prior Work

Habitra was built by a single author, **Viola Kendall**, and the complete git
history is available in this repository: **24 commits between 2026-09-04 and
2026-09-09**.

**Repository evidence is not sufficient to confidently attribute individual
features to a pre-hackathon versus during-hackathon window.** The commit history
records *when* work landed in version control, but it does not record when each
feature was first conceived or drafted, and the hackathon's official window dates
are not recorded anywhere in the repository. Rather than invent a timeline, the
full commit log is reproduced below as the factual record.

| Commit | Date | Subject |
| --- | --- | --- |
| `0273df6` | 2026-09-04 | Set up Habitra frontend foundation |
| `cf22c36` | 2026-09-04 | Set up Habitra backend foundation |
| `368f151` | 2026-09-04 | Set up Prisma database foundation |
| `089fc7d` | 2026-09-04 | Implement user registration |
| `95bbd2b` | 2026-09-04 | Implement user login |
| `d6c6840` | 2026-09-04 | Add habit data model |
| `894aafd` | 2026-09-04 | Add JWT authentication |
| `f4340e6` | 2026-09-05 | Implement create habit API |
| `f32cdba` | 2026-09-05 | Implement get habits API |
| `2db1f56` | 2026-09-05 | Add habit completion data model |
| `a9cee05` | 2026-09-05 | Implement habit completion API |
| `f296889` | 2026-09-05 | Implement get habit completion history API |
| `44b587e` | 2026-09-05 | Implement analytics API |
| `eaec540` | 2026-09-05 | Add Gemini API SDK |
| `a972432` | 2026-09-05 | Configure Gemini API environment |
| `e97adaa` | 2026-09-05 | Refactor analytics into service |
| `3226af1` | 2026-09-05 | Implement forgot password flow |
| `da209c9` | 2026-09-06 | Complete Habitra agent and Sibyl memory milestone |
| `edd2e80` | 2026-09-06 | Complete Challenges phase |
| `a8d0843` | 2026-09-07 | Implement Virtuals ACP v2 intervention flow |
| `113f258` | 2026-09-09 | Complete Base Sepolia integration |
| `b559626` | 2026-09-09 | Complete dashboard notifications and escrow reconciliation |
| `56d0bc2` | 2026-09-09 | Fix Agent UI test race and wallet copy |
| `52e4241` | 2026-09-09 | Fix Virtuals intervention provider test |

All work in this repository is original to this project. `PRD.md` (the product
requirements document) has been present since the initial commits and drove the
build order. No third-party code was vendored in.

---

## License

[MIT](./LICENSE) © 2026 Viola Kendall

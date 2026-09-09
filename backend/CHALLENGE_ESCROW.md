# Challenge → BEES Escrow Integration (developer note)

Short note on how Habitra's **off-chain challenge evaluator** is wired to the
**on-chain `HabitraChallengeEscrow`** contract.

- Integration boundary: [`src/services/challengeEscrow.ts`](src/services/challengeEscrow.ts)
- Contract layer: [`../contracts/README.md`](../contracts/README.md)
- Chain: Base Sepolia (`84532`). Mainnet is never used.
- Default mode: `DEMO_CHAIN_MODE=true`.

---

## 1. Offchain — who decides pass/fail

`src/services/challenges.ts` is **the only source of truth for the verdict**. It
reads habit completions and derives the challenge status:

| Condition | Status |
| --- | --- |
| `daysMissed > maxMisses` | `FAILED` (`MISSES_EXCEEDED`) |
| linked habit count ≠ 1 | `FAILED` (`INVALID_LINKED_HABIT_COUNT`) |
| today's UTC day > `endDate` | `COMPLETED` |
| otherwise | unchanged (`DRAFT` / `ACTIVE`) |

`challengeEscrow.ts` **never decides the verdict**. It only enforces the
*economic consequence* of a verdict the evaluator already reached:

```
evaluator → COMPLETED → settle(succeeded = true)   → stake returned  → CLAIM
evaluator → FAILED    → settle(succeeded = false)  → stake slashed   → PENALTY
```

If the two ever disagree, the challenge status wins: `settleChallenge()`
rejects a settlement whose `succeeded` flag does not match the stored status.

## 2. Onchain — who enforces the consequence

`HabitraChallengeEscrow` holds the locked BEES and is the only thing that can
move them. The contract **never reads Habitra's database**, and Habitra's
database is never used to invent a verdict.

- `lock(challengeId, amount, endsAt)` — pulls BEES from `msg.sender` (the user).
- `settle(commitmentId, succeeded)` — resolver-only; success returns the stake
  to the user, failure sends it to the treasury.

The backend looks up an on-chain commitment from the off-chain challenge id via
`commitmentIdByChallenge(challengeId)`, so no database state is ever pushed on
chain. See [`../contracts/README.md`](../contracts/README.md) for the trust
boundary and the resolver trust assumption.

## 3. Demo mode — `DEMO_CHAIN_MODE=true` (default)

No RPC call, no signing, **no transaction is ever broadcast**.

The service validates *the same business conditions the live path would
require*, then writes a `Transaction` row so the flow is observable:

1. the challenge exists **and belongs to the authenticated user**;
2. the challenge is in a terminal state (`COMPLETED` / `FAILED`) for settlement;
3. the user has a wallet linked on chain 84532;
4. a stake was actually locked (settlement only);
5. no non-`FAILED` settlement row already exists.

A demo row is **simulated**, and it says so:

- `txHash` is always `null` — a hash is **never** fabricated;
- `simulated: true` on every response;
- messages read *"Simulated demo settlement … No on-chain transaction was
  submitted and no BEES moved."*

> **Simulated marker:** a `Transaction` with `txHash == null` is simulated; a
> real record always carries a hash. This is exposed as
> `isSimulatedTransaction()` and needed **no Prisma schema change**.

## 4. Live mode — `DEMO_CHAIN_MODE=false`

Uses the existing viem configuration in `src/services/blockchain.ts` and the
generated ABIs in `src/contracts/`. There is only **one** blockchain client in
the codebase; `challengeEscrow.ts` adds no second one.

**Settlement (backend-signed).** Reads `commitmentIdByChallenge`, re-reads
`commitment.settled`, then submits `settle(commitmentId, succeeded)` with the
resolver key from the environment and stores the real `txHash` on `CONFIRMED`.

**Stake lock (user-signed).** `lock` pulls BEES from `msg.sender`, i.e. the
user, and Habitra never holds a user key. The backend records a `PENDING` row
and returns `202` with a contract-call descriptor (`address`, `functionName`,
`args`) so the user's wallet can approve the escrow and send the transaction
itself.

**Configuration** (`backend/.env`, never committed):

```
DEMO_CHAIN_MODE=false
BASE_RPC_URL=...
BEES_TOKEN_ADDRESS=0x...
CHALLENGE_CONTRACT_ADDRESS=0x...
ESCROW_RESOLVER_PRIVATE_KEY=...   # resolver signer only
```

`ESCROW_RESOLVER_PRIVATE_KEY` is read from the environment at run time only. It
is never written to disk by the app, never logged, and never sent to a client.
Leaving it empty disables on-chain settlement (`NO_SIGNER`) while the demo path
keeps working. **No contract has been deployed and nothing has been broadcast.**

## 5. Idempotency and failure handling

- Settlement is **one-shot per challenge**. A `CLAIM`/`PENALTY` row that is not
  `FAILED` counts as "already settled", so re-running evaluation never
  duplicates it. In live mode the on-chain `settled` flag is re-read before
  settling — the authoritative second line of defence.
- A reverted or unsubmittable on-chain settlement marks the row `FAILED` and
  returns `ok: false` / `ONCHAIN_FAILED` with *"No BEES were returned or
  slashed."* It never claims a financial outcome that did not happen.
- The evaluate route calls settlement inside a `try/catch` and only logs on
  failure, so an escrow problem can never change the verdict or fail the
  request.
- `challengeEscrow.ts` does not throw for expected conditions; it returns a
  typed `EscrowResult` with a machine-readable `code`.

## 6. API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/challenges/:challengeId/stake` | Lock a stake (`{ amount }` in BEES base units) |
| `GET` | `/api/challenges/:challengeId/escrow` | Read-only escrow state for the owner |
| `POST` | `/api/challenges/:challengeId/evaluate` | Existing evaluator; now also triggers settlement |

Status mapping: `201` created · `200` duplicate no-op · `202` user signature
required · `404` not found/not yours · `400` invalid amount/date · `409` no
wallet / no stake / wrong state · `503` chain, signer or on-chain failure.

## 7. Limits

`Transaction.amount` is a Prisma `BigInt` stored as Postgres `int8`, so the
largest representable stake is `2^63 - 1` base units — about **9.22 BEES** at 18
decimals. Larger amounts are rejected with `INVALID_AMOUNT`.

## 8. Tests

```bash
npm run test:challenge_escrow      # 48 checks
npm run test:challenges_service
npm run test:challenges_api
npm run test:blockchain_persistence
npm run test:wallet_api
```

The escrow suite covers: demo `FUND` / `CLAIM` / `PENALTY` creation; success and
failure cannot settle twice; another user's challenge cannot be settled; no
linked wallet cannot be settled; non-terminal statuses cannot be settled;
re-running evaluation creates no duplicate settlement; simulated rows never
carry a fabricated hash; oversized amounts are rejected; escrow state is owner
only and requires authentication.

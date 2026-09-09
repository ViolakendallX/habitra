# Habitra on-chain layer (Base Sepolia + BEES)

> **Status: implemented, compiled and unit-tested locally. NOT deployed.**
> No contract has been deployed to Base Sepolia (or any other network). No
> private key is stored, requested or referenced anywhere in this repository.

This directory contains the minimal Base + BEES on-chain layer for Habitra: two
Solidity contracts, their tests, a deployment script that is **never executed
automatically**, and the generated TypeScript ABIs consumed by the backend and
the frontend.

> **Backend integration.** The service that connects the off-chain challenge
> evaluator to this escrow, and the demo/live behaviour, is documented in
> [`../backend/CHALLENGE_ESCROW.md`](../backend/CHALLENGE_ESCROW.md).

```
contracts/
  src/
    BEES.sol                    ERC-20 demo token ("Habitra BEES", BEES, 18 dp)
    HabitraChallengeEscrow.sol  Challenge stake escrow (lock -> settle)
  test/onchain.test.js          16 contract tests (Hardhat network + viem)
  scripts/
    deploy.js                   Base Sepolia deploy script — NOT executed
    export-abis.js              artifacts -> TS ABIs for backend/frontend
  hardhat.config.js             solc 0.8.28, baseSepolia network declared
```

---

## 1. What BEES represents

BEES is a **demo/test ERC-20 token on Base Sepolia (chain id 84532)**.

- Name `Habitra BEES`, symbol `BEES`, 18 decimals.
- It represents *habit consistency*, not money. It has **no market value, no
  liquidity, no bridge and no mainnet deployment**.
- Its only purpose is to let the accountability loop be exercised end-to-end on
  a real EVM chain with real ERC-20 semantics — approve, transfer, escrow,
  settle — while risking nothing of value.
- Minting is **owner-only** (`BEES.mint`). There is no public mint, no faucet
  and no minter role beyond the owner, so an arbitrary address cannot inflate
  the supply. The owner is a Habitra test EOA on Base Sepolia.

## 2. How a Habitra challenge maps to an on-chain commitment

The off-chain `Challenge` record (Prisma) and the on-chain `Commitment` struct
mirror each other one-to-one:

| Off-chain (`Challenge`, `services/challenges.ts`) | On-chain (`Commitment`)              |
| ------------------------------------------------- | ------------------------------------ |
| `Challenge.id` (cuid)                              | `challengeId` (string, ≤ 64 bytes)   |
| Wallet owner (`Wallet.address` for chain 84532)    | `user` (`msg.sender` at lock time)   |
| Chosen stake, in BEES base units                   | `amount`                             |
| `Challenge.endDate` (UTC day)                      | `endsAt` (unix seconds)              |
| `status = COMPLETED / FAILED`                      | `succeeded` (bool, set at settlement)|
| —                                                  | `settled` (replay guard)             |

Existing `Transaction` rows line up with the on-chain calls:

| On-chain call        | `Transaction.type` | Meaning                     |
| -------------------- | ------------------ | --------------------------- |
| `lock(...)`          | `FUND`             | Stake committed             |
| `settle(id, true)`   | `CLAIM`            | Stake returned (user passed)|
| `settle(id, false)`  | `PENALTY`          | Stake slashed (user failed) |

### Lifecycle

1. **Create (off-chain).** User creates a `Challenge` with one linked habit,
   dates and `maxMisses`, and picks a BEES stake.
2. **Approve (on-chain, user-signed).** `BEES.approve(escrow, amount)`. The
   escrow can never pull more than the user approved.
3. **Lock (on-chain, user-signed).** `lock(challengeId, amount, endsAt)` pulls
   exactly `amount` into the escrow via `safeTransferFrom` and records the
   commitment. Reverts if: stake is zero, challenge id is empty or > 64 bytes,
   `endsAt` is not in the future, or that challenge id is already locked.
4. **Evaluate (off-chain).** The existing evaluator
   (`backend/src/services/challenges.ts`) derives `COMPLETED` / `FAILED` from
   `HabitCompletion` rows and `maxMisses`.
5. **Settle (on-chain, resolver-signed).** `settle(commitmentId, succeeded)`.

## 3. What happens on pass, and what happens on fail

- **Pass — `settle(id, true)`:** the **full** stake is transferred from the
  escrow back to `user`. Emits `ChallengeCompleted`. Off-chain this is recorded
  as a `CLAIM` transaction.
- **Fail — `settle(id, false)`:** the **full** stake is transferred from the
  escrow to `treasury`, a single explicit address set at deployment and
  changeable only by the owner. Emits `ChallengeFailed`. Off-chain this is a
  `PENALTY` transaction.

There is **no partial slashing and no reward minting** in this stage — the
stake is all-or-nothing. Settlement is **one-shot**: `settled` is written before
the token transfer, so a commitment can never pay out twice, and a second
`settle` reverts with `escrow: already settled`.

## 4. On-chain vs off-chain (the trust boundary)

| Concern                                             | Where it lives |
| --------------------------------------------------- | -------------- |
| Habit definitions, daily completions, misses         | **Off-chain** (Postgres) |
| Whether a challenge passed or failed                 | **Off-chain** (`services/challenges.ts`) |
| User identity, wallet address linkage                | **Off-chain** (`Wallet` model) |
| BEES balances, approvals, escrow custody             | **On-chain** |
| The economic consequence (return vs. slash)          | **On-chain** |
| Replay protection (one settlement, ever)             | **On-chain** |
| Who may trigger settlement                           | **On-chain** (`resolver` role) |

**The chain enforces the consequence, not the judgement.** Habit performance
data does not exist on-chain and cannot be verified by a contract, so Habitra's
off-chain evaluator decides pass/fail and the contract only executes the
resulting transfer. This is the documented trust boundary of the demo layer.

### What the contract guarantees, even if the backend is compromised

- **The backend cannot arbitrarily withdraw user funds.** `HabitraChallengeEscrow`
  has **no `withdraw`, `sweep`, `rescue` or `drain` function at all** — the only
  state-changing entry points are `lock`, `settle`, `setTreasury`, `setResolver`
  and the two `Ownable` ownership functions. A test asserts this explicitly by
  inspecting the ABI.
- **Locked stakes are untouchable by the owner.** `setTreasury` / `setResolver`
  only affect *future* settlements; funds already in escrow are unaffected.
- **Non-resolvers cannot settle.** `settle` reverts with
  `escrow: caller is not the resolver` for any other caller, including the owner
  when the owner is not the resolver.
- **A commitment settles at most once.**

### Known limitation (documented on purpose)

`resolver` is a trusted role. A compromised resolver could settle a live
commitment early. Accepting that is what keeps this layer *minimal*: the
alternative — an oracle or optimistic dispute window — is out of scope for this
stage. Mitigations in place: a single Habitra-controlled EOA, every settlement
emits an event, and every settlement is mirrored into the off-chain
`Transaction` table so misuse is visible and auditable.

## 5. Security properties

- Solidity **0.8.28** — checked arithmetic, no `unchecked` blocks, no assembly.
- **OpenZeppelin Contracts v5** for `ERC20`, `Ownable`, `SafeERC20`,
  `ReentrancyGuard` and `IERC20`.
- **SafeERC20** for every token movement (tolerates non-standard return values).
- **Checks-Effects-Interactions** plus `nonReentrant` on `lock` and `settle`.
- Explicit roles: `owner` (admin: treasury + resolver address only) and
  `resolver` (the only address allowed to settle).
- Zero-address validation on every address input.
- **No private key, seed phrase or secret appears in any source file.** The
  deploy script reads `DEPLOYER_PRIVATE_KEY` from the environment at run time
  only, and never logs it.
- Base Sepolia **only**. `scripts/deploy.js` refuses to run on any chain whose
  id is not `84532`, and hardhat.config.js declares no mainnet network.

## 6. Commands

```bash
cd contracts
npm install          # hardhat, viem, @openzeppelin/contracts
npm run compile      # solc 0.8.28, optimizer on
npm test             # 15 contract tests on the in-process Hardhat network
node scripts/export-abis.js   # regenerate TS ABIs after a contract change
```

`npm test` runs entirely locally: no RPC calls, no Base Sepolia connection, no
deployment.

## 7. Deployment — configured but NOT performed

`scripts/deploy.js` is provided for review only. It fails closed: it refuses to
run unless the target chain is Base Sepolia (84532) and `BASE_RPC_URL`,
`DEPLOYER_PRIVATE_KEY` and `TREASURY_ADDRESS` are all present in the
environment. **It has never been executed.** When an operator chooses to deploy:

```bash
BASE_RPC_URL=https://sepolia.base.org \
DEPLOYER_PRIVATE_KEY=<throwaway testnet key> \
TREASURY_ADDRESS=0x... \
npm run deploy:base-sepolia
```

Then put the two printed addresses into `backend/.env`:

```
BEES_TOKEN_ADDRESS=0x...
CHALLENGE_CONTRACT_ADDRESS=0x...
```

`DEMO_CHAIN_MODE` stays `true` by default in development, so nothing on the
backend changes behaviour until those addresses are set **and** demo mode is
explicitly turned off.

## 8. Generated ABIs

`scripts/export-abis.js` writes identical `as const` ABI modules to:

- `backend/src/contracts/abi.ts`
- `frontend/src/lib/contracts/abi.ts`

They are typed `as const` so viem infers function names, argument types and
return types with no codegen step. Regenerate after every contract change.

## 9. Explicitly out of scope

Staking, yield, NFTs, DeFi integrations, governance, partial slashing, multi-
token support, mainnet, fiat on/off ramps, and any automated deployment. This
layer does one thing: turn a habit commitment into a reversible-or-losable
on-chain stake.

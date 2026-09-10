# Habitra — Base Sepolia Deployment Readiness

> **STATUS UPDATE — the deployment described here has since been performed.**
> This document was written as a pre-deployment readiness review and is retained
> for the record. Both contracts are now live on Base Sepolia (84532) and a stake
> is locked. See [§6 Deployment outcome](#6-deployment-outcome).
> **Settlement has NOT been executed.**

**Status at time of writing:** READY for a safe, manual, operator-triggered deployment.
No transaction had yet been broadcast. No key was read, printed, logged, committed, or requested. No Solidity was modified.

---

## 1. Deployment readiness

- **READY.** All 12 readiness points hold (see §4). The on-chain layer compiles, all 16 contract tests pass, and the backend/frontend build/typecheck are clean.
- The single production-file change was a **defence-in-depth safety guard** in `contracts/scripts/deploy.js` (it still refuses to run unless the live RPC really is Base Sepolia, so a misconfigured `BASE_RPC_URL` cannot send funds to the wrong chain).

## 2. Blockers

- **None.** The only open items are *operator choices* for the manual deploy step (use a throwaway testnet key; set `TREASURY_ADDRESS` deliberately; optionally rotate `resolver` to a dedicated EOA via `setResolver` post-deploy).

## 3. Files changed (exact)

| File | Change | Why |
|------|--------|-----|
| `contracts/scripts/deploy.js` | Added a live-chain guard after the viem clients are built: `const liveChainId = await publicClient.getChainId(); if (liveChainId !== 84532) throw`. | The previous check only proved `--network baseSepolia` was passed (Hardhat config chainId). A misconfigured `BASE_RPC_URL` (e.g. mainnet) would otherwise broadcast real funds to the wrong chain. This enforces "never Base mainnet". |

Everything else was **read-only inspection / verification**. No Solidity, no backend service, no frontend, no env, no migration changed. `DEMO_CHAIN_MODE` is unchanged (still defaults `true`).

## 4. Verification results (exact)

| Check | Command / Action | Result |
|-------|------------------|--------|
| Solidity compile | `hardhat compile --force` (contracts/) | ✅ `Compiled 15 Solidity files successfully (evm target: paris)` |
| Contract tests | `hardhat test` (contracts/) | ✅ **16/16 passing** (BEES ×3, HabitraChallengeEscrow ×13) |
| Backend typecheck | `npm run typecheck` (backend/) | ✅ 0 errors |
| Frontend typecheck + build | `npm run build` (frontend/) | ✅ `tsc --noEmit` clean + `vite build` success (39 modules, dist emitted) |
| Dry-run A — wrong network | `hardhat run scripts/deploy.js` (default `hardhat` net) | ✅ `Error: Refusing to deploy: this script only targets Base Sepolia (84532), got chainId 31337.` |
| Dry-run B — missing secrets | `--network baseSepolia` with env unset | ✅ `Error: Missing required environment variable BASE_RPC_URL. Deployment is a manual operator action; nothing is deployed automatically.` |
| Dry-run C — wrong RPC chain | `--network baseSepolia`, `BASE_RPC_URL` → mainnet RPC + dummy key | ✅ Script errors on the RPC call (sandbox blocks egress) **before any broadcast** — fail-closed. The exact "points at chainId 1" message is reached by code review the moment `getChainId()` returns a non-84532 value. |
| git secret hygiene | `git ls-files \| grep .env` + `git check-ignore` | ✅ No `.env` tracked; `backend/.env` confirmed ignored; no stray `.env` in index. |

### 12-point readiness matrix

1. ✅ Hardhat Base Sepolia chain id = **84532** (`hardhat.config.js`).
2. ✅ Deploy script refuses every chain except 84532 (config-chain check **and** new live-chain check).
3. ✅ Deployer key required from `DEPLOYER_PRIVATE_KEY` **at runtime only**; empty → no signer / throws.
4. ✅ No private key, seed, or secret anywhere in source (verified across `*.sol`, `deploy.js`, `env.ts`, `blockchain.ts`).
5. ✅ No key is printed or logged (script logs only `account.address` — the public address).
6. ✅ BEES deployed **first**; escrow receives the returned `beesAddress`.
7. ✅ Escrow constructor gets the correct `BEES_TOKEN_ADDRESS` (`[beesAddress, treasury, account.address]`).
8. ✅ `TREASURY_ADDRESS` required from env (zero-address rejected in contract); `resolver` = deployer EOA (owner-only `setResolver` available).
9. ✅ Output prints `BEES_TOKEN_ADDRESS=…` and `CHALLENGE_CONTRACT_ADDRESS=…`.
10. ✅ Those names map exactly to `env.ts` `BEES_TOKEN_ADDRESS` / `CHALLENGE_CONTRACT_ADDRESS`.
11. ✅ `DEMO_CHAIN_MODE` unchanged — still defaults `true` in dev; backend `/api/blockchain/status` and Wallet page unaffected.
12. ✅ Existing local tests/builds still green (compile, 16 contract tests, backend typecheck, frontend build).

### Dependency compatibility

- `@openzeppelin/contracts@^5.6.1` (requires Solidity ≥0.8.20) + `solc 0.8.28` ✅
- `hardhat@^2.29.1` + `viem@^2.56.3` ✅ (compile + tests pass; `export-abis.js` and `deploy.js` both use viem over a Hardhat provider / `http` transport)

## 5. Environment variables needed LATER (operator-supplied; values never requested here)

Set these **only at manual deploy time**, in the shell running the deploy script:

| Var | Purpose | Notes |
|-----|---------|-------|
| `BASE_RPC_URL` | Base Sepolia RPC endpoint | e.g. `https://sepolia.base.org` |
| `DEPLOYER_PRIVATE_KEY` | Throwaway Base Sepolia testnet EOA | Becomes BEES owner + initial escrow `resolver`. Read at runtime only; **never** committed, logged, or put in source. |
| `TREASURY_ADDRESS` | Recipient of slashed stakes | Deployer or a separate EOA; set deliberately. |

After a successful run, copy the printed addresses into `backend/.env` (gitignored, never committed):

| Var | Purpose |
|-----|---------|
| `BEES_TOKEN_ADDRESS` | From script output |
| `CHALLENGE_CONTRACT_ADDRESS` | From script output |
| `ESCROW_RESOLVER_PRIVATE_KEY` | Only if you later enable real on-chain settlement (`DEMO_CHAIN_MODE=false`) |

## Manual deploy command (for the operator, future)

```bash
BASE_RPC_URL=https://sepolia.base.org \
DEPLOYER_PRIVATE_KEY=<throwaway testnet key> \
TREASURY_ADDRESS=0x... \
npm run deploy:base-sepolia
```

Then keep `DEMO_CHAIN_MODE=true` until you explicitly choose to flip to live mode.

---

## 6. Deployment outcome

The operator subsequently deployed both contracts to Base Sepolia. Verified
against a live RPC:

| Contract | Address |
| --- | --- |
| BEES | `0x43e67b33248e3262fe12d3ae826850936a2d1cd9` |
| HabitraChallengeEscrow | `0x3211fe09b5ad90a40d4a21f779d07c1a7e0c3c4f` |

Three transactions in total:

| Step | Transaction | Detail |
| --- | --- | --- |
| Mint | `0xf473926151989e969ec542fbef218a8fcec0297ee1f77457817df77e28a52870` | 5 BEES minted to the demo user |
| Approve | `0x570c29f958ef75ec19d60fcc09b8772c66dd4bb6b2c97911b9d10329efbd73ec` | Block 46581162, escrow approved for 5 BEES |
| Lock | `0x7bafb7c21c9e7c0a8d26a04fca1385c944b625c63363d1c2854ba5a88efb91c3` | Block 46581419, `lock()` (selector `0x57b2d76f`), status success |

Commitment id `1` holds 5 BEES with `settled = false` and `isPending = true`.
**No settlement has been executed** — no reward paid, no penalty slashed.

---

*Prepared by WorkBuddy AI. The readiness review itself deployed nothing; the
subsequent operator deployment is recorded in §6.*

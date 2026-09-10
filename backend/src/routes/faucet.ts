import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { isAddress, getAddress } from 'viem';

import { requireAuth, UNAUTHORIZED } from '../middleware/auth.js';
import {
  BlockchainPersistenceError,
  DEFAULT_CHAIN_ID,
  getUserWalletForChain,
} from '../services/blockchainPersistence.js';
import { AlreadyClaimedError, claimBeesTo } from '../services/faucet.js';

const claimSchema = z
  .object({
    address: z.string().trim().min(1, 'Wallet address is required.'),
  })
  .superRefine((value, ctx) => {
    if (!isAddress(value.address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Invalid EVM wallet address.',
      });
    }
  });

export const faucetRouter: Router = Router();

/**
 * POST /claim — server-side distribution of 10 BEES to a pasted public address.
 *
 * The caller must be authenticated and the requested `address` must equal the
 * address they linked for Base Sepolia (chainId 84532). This keeps the faucet
 * tied to a real Habitra account and stops one account from draining the
 * faucet for arbitrary addresses. The actual transfer is performed on-chain by
 * HabitraBeesFaucet.claimFor(); the contract's hasClaimed guard makes the claim
 * one-per-address and idempotent.
 */
faucetRouter.post('/claim', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const parsed = claimSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const requested = getAddress(parsed.data.address);

  try {
    // Tie the claim to the authenticated user's linked wallet on Base Sepolia.
    const linked = await getUserWalletForChain(authenticatedUser.id, DEFAULT_CHAIN_ID);
    if (!linked || linked.address.toLowerCase() !== requested.toLowerCase()) {
      res.status(403).json({
        status: 'error',
        message: 'You can only claim BEES for the wallet address linked to your account.',
      });
      return;
    }

    const result = await claimBeesTo(requested);

    res.status(200).json({
      status: 'success',
      data: {
        txHash: result.txHash,
        amount: result.amount.toString(),
        recipient: result.recipient,
        claimed: true,
      },
    });
  } catch (err) {
    if (err instanceof AlreadyClaimedError) {
      res.status(409).json({ status: 'error', message: err.message });
      return;
    }
    if (err instanceof BlockchainPersistenceError) {
      res.status(400).json({
        status: 'error',
        message: 'Link a public wallet address on Base Sepolia before claiming BEES.',
      });
      return;
    }
    // viem surfaces the contract's custom error as `AlreadyClaimed()` (no
    // space), so match both spellings.
    if (err instanceof Error && /already\s*claimed/i.test(err.message)) {
      res.status(409).json({
        status: 'error',
        message: 'This address has already claimed BEES from the faucet.',
      });
      return;
    }
    if (err instanceof Error && /invalid wallet address/i.test(err.message)) {
      res.status(400).json({ status: 'error', message: err.message });
      return;
    }
    res.status(500).json({
      status: 'error',
      message: 'Unable to distribute BEES right now. Please try again.',
    });
  }
});

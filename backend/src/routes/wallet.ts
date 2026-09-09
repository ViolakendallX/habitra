import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { isAddress } from 'viem';

import { requireAuth, UNAUTHORIZED } from '../middleware/auth.js';
import {
  BlockchainPersistenceError,
  connectWallet,
  DEFAULT_CHAIN_ID,
  getUserWalletForChain,
  SUPPORTED_CHAIN_IDS,
} from '../services/blockchainPersistence.js';

const connectWalletSchema = z
  .object({
    address: z.string().trim().min(1, 'Wallet address is required.'),
    chainId: z.number().int('chainId must be an integer.').optional(),
  })
  .superRefine((value, ctx) => {
    if (!isAddress(value.address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Invalid EVM wallet address.',
      });
    }
    if (
      value.chainId !== undefined &&
      !(SUPPORTED_CHAIN_IDS as readonly number[]).includes(value.chainId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chainId'],
        message: `Unsupported chainId. Supported: ${SUPPORTED_CHAIN_IDS.join(', ')}.`,
      });
    }
  });

function parseChainIdQuery(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const num = Number(raw);
  return Number.isInteger(num) ? num : null;
}

export const walletRouter: Router = Router();

walletRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const parsed = connectWalletSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const { address, chainId } = parsed.data;

  try {
    const wallet = await connectWallet({
      userId: authenticatedUser.id,
      address,
      ...(chainId !== undefined ? { chainId } : {}),
    });

    res.status(201).json({
      status: 'success',
      data: { wallet },
    });
  } catch (err) {
    if (err instanceof BlockchainPersistenceError) {
      if (err.message.includes('already linked')) {
        res.status(409).json({ status: 'error', message: err.message });
        return;
      }
      res.status(400).json({
        status: 'error',
        message: 'Validation failed.',
        errors: { address: [err.message] },
      });
      return;
    }
    res.status(500).json({ status: 'error', message: 'Unable to connect wallet.' });
  }
});

walletRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  const requested = parseChainIdQuery(req.query.chainId);
  if (requested !== null && !(SUPPORTED_CHAIN_IDS as readonly number[]).includes(requested)) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: {
        chainId: [`Unsupported chainId. Supported: ${SUPPORTED_CHAIN_IDS.join(', ')}.`],
      },
    });
    return;
  }

  const chainId = requested ?? DEFAULT_CHAIN_ID;

  try {
    const wallet = await getUserWalletForChain(authenticatedUser.id, chainId);
    res.status(200).json({
      status: 'success',
      data: { wallet },
    });
  } catch {
    res.status(500).json({ status: 'error', message: 'Unable to load wallet.' });
  }
});

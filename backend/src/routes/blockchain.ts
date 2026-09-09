import { Router, type Request, type Response } from 'express';

import { requireAuth, UNAUTHORIZED } from '../middleware/auth.js';
import { getBlockchainStatus } from '../services/blockchain.js';
import { DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from '../services/blockchainPersistence.js';

export const blockchainRouter: Router = Router();

blockchainRouter.get('/status', requireAuth, async (req: Request, res: Response) => {
  const authenticatedUser = req.authUser;
  if (!authenticatedUser) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }

  try {
    const status = getBlockchainStatus();
    res.status(200).json({
      status: 'success',
      // Public configuration only — never includes secrets. Returns the current
      // demo/live mode, configured chain id, and the (empty until deployed)
      // contract addresses so the frontend knows what chain to target.
      data: {
        ...status,
        defaultChainId: DEFAULT_CHAIN_ID,
        supportedChainIds: SUPPORTED_CHAIN_IDS,
      },
    });
  } catch {
    res.status(500).json({ status: 'error', message: 'Unable to load blockchain status.' });
  }
});

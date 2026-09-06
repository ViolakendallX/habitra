import { Router, type Request, type Response } from 'express';

import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';
import {
  AgentServiceError,
  accountabilityAgentService,
  type AgentRecommendationResponse,
} from '../services/agent.js';

interface AgentServiceLike {
  generateRecommendation: (userId: string) => Promise<AgentRecommendationResponse>;
}

export function createAgentRouter(service: AgentServiceLike = accountabilityAgentService): Router {
  const router = Router();

  router.get('/recommendation', requireAuth, async (req: Request, res: Response) => {
    const authenticatedUser = req.authUser;
    if (!authenticatedUser) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    try {
      const recommendation = await service.generateRecommendation(authenticatedUser.id);
      res.status(200).json({ status: 'success', data: { recommendation } });
    } catch (err) {
      if (err instanceof AgentServiceError) {
        if (err.code === 'GEMINI_NOT_CONFIGURED') {
          res.status(503).json({
            status: 'error',
            message: 'Agent is not configured.',
          });
          return;
        }

        if (err.code === 'MALFORMED_MODEL_OUTPUT' || err.code === 'GEMINI_REQUEST_FAILED') {
          res.status(502).json({
            status: 'error',
            message: 'Unable to generate recommendation right now.',
          });
          return;
        }
      }

      res.status(500).json({
        status: 'error',
        message: 'Unable to generate recommendation right now.',
      });
    }
  });

  return router;
}

export const agentRouter = createAgentRouter();

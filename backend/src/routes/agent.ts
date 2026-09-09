import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { UNAUTHORIZED, requireAuth } from '../middleware/auth.js';
import {
  AgentServiceError,
  accountabilityAgentService,
  type AgentRecommendationResponse,
} from '../services/agent.js';
import { recordRecommendationOutcome } from '../services/memory.js';

interface AgentServiceLike {
  generateRecommendation: (userId: string) => Promise<AgentRecommendationResponse>;
}

/**
 * Body for recording how a recommendation turned out. Every field is optional and
 * nullable so a client can report only what it knows; an absent field leaves the
 * existing value untouched, and an explicit null means "unknown" (never success).
 */
const recommendationOutcomeSchema = z.object({
  accepted: z.boolean().nullable().optional(),
  helpful: z.boolean().nullable().optional(),
  text: z.string().max(4000).nullable().optional(),
  source: z.string().min(1).max(120).optional(),
});

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

  router.post(
    '/recommendations/:recommendationId/outcome',
    requireAuth,
    async (req: Request, res: Response) => {
      const authenticatedUser = req.authUser;
      if (!authenticatedUser) {
        res.status(401).json(UNAUTHORIZED);
        return;
      }

      const recommendationId = String(req.params?.recommendationId ?? '');
      if (!/^[\w-]{1,120}$/.test(recommendationId)) {
        res.status(400).json({
          status: 'error',
          message: 'Invalid recommendation id.',
        });
        return;
      }

      const parsed = recommendationOutcomeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          status: 'error',
          message: 'Validation failed.',
          errors: z.flattenError(parsed.error).fieldErrors,
        });
        return;
      }

      try {
        const result = await recordRecommendationOutcome(authenticatedUser.id, recommendationId, {
          accepted: parsed.data.accepted,
          helpful: parsed.data.helpful,
          text: parsed.data.text,
          source: parsed.data.source,
        });

        if (!result.ok) {
          res.status(502).json({
            status: 'error',
            message: result.error?.message ?? 'Unable to record recommendation outcome.',
          });
          return;
        }

        res.status(200).json({ status: 'success', data: { recorded: true } });
      } catch {
        res.status(500).json({
          status: 'error',
          message: 'Unable to record recommendation outcome.',
        });
      }
    },
  );

  return router;
}

export const agentRouter = createAgentRouter();

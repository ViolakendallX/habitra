import * as bcrypt from 'bcrypt';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';

/**
 * Authentication routes (PRD section 6).
 *
 * Registration flow:
 *   validate input -> check existing email -> hash password -> create user
 *
 * bcrypt cost factor. 12 rounds is the current OWASP recommendation; raise it
 * if the hosting hardware gets faster.
 */
const SALT_ROUNDS = 12;

/**
 * Columns that are safe to expose. passwordHash is deliberately omitted, and
 * the list is applied through Prisma's `select` so fields added to the User
 * model later can never leak by accident.
 */
const publicUserFields = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} as const;

const registrationSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required.')
    .max(100, 'Name must be 100 characters or fewer.'),
  email: z
    .email('Enter a valid email address.')
    .max(255, 'Email must be 255 characters or fewer.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    // bcrypt only uses the first 72 bytes, so longer passwords add no security.
    .max(72, 'Password must be 72 characters or fewer.'),
});

type RegistrationInput = {
  name?: unknown;
  email?: unknown;
  password?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Trims whitespace and lowercases the email before validation so that
 * "Ada@Example.com " and "ada@example.com" resolve to the same account.
 */
function normalizeRegistrationInput(body: RegistrationInput) {
  return {
    name: readString(body.name)?.trim(),
    email: readString(body.email)?.trim().toLowerCase(),
    password: readString(body.password),
  };
}

/**
 * Prisma raises P2002 when a unique constraint is violated. The explicit
 * existence check below catches the normal case; this covers the race where a
 * second request registers the same email before the first insert commits.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export const authRouter: Router = Router();

authRouter.post('/register', async (req: Request, res: Response) => {
  const parsed = registrationSchema.safeParse(
    normalizeRegistrationInput((req.body ?? {}) as RegistrationInput),
  );

  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const { name, email, password } = parsed.data;

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser) {
    res.status(409).json({
      status: 'error',
      message: 'An account with this email address already exists.',
    });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const user = await prisma.user.create({
      data: { name, email, passwordHash },
      select: publicUserFields,
    });

    res.status(201).json({ status: 'success', data: { user } });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      res.status(409).json({
        status: 'error',
        message: 'An account with this email address already exists.',
      });
      return;
    }

    throw error;
  }
});

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import {
  AUTH_COOKIE,
  buildClearCookieOptions,
  buildCookieOptions,
  signAuthToken,
} from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { normalizeEmail, passwordSchema, readString } from '../auth/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { publicUserFields } from '../auth/select.js';

/**
 * Authentication routes (PRD section 6).
 *
 * Registration flow:
 *   validate input -> check existing email -> hash password -> create user
 * Login flow:
 *   validate input -> find user by normalized email -> verify bcrypt hash
 *
 * bcrypt cost factor. 12 rounds is the current OWASP recommendation; raise it
 * if the hosting hardware gets faster.
 */

const registrationSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required.')
    .max(100, 'Name must be 100 characters or fewer.'),
  email: z
    .email('Enter a valid email address.')
    .max(255, 'Email must be 255 characters or fewer.'),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: z
    .email('Enter a valid email address.')
    .max(255, 'Email must be 255 characters or fewer.'),
  password: z
    .string()
    .min(1, 'Password is required.')
    .max(72, 'Password must be 72 characters or fewer.'),
});

type RegistrationInput = {
  name?: unknown;
  email?: unknown;
  password?: unknown;
};

type LoginInput = {
  email?: unknown;
  password?: unknown;
};

/**
 * Normalizes registration input before validation.
 */
function normalizeRegistrationInput(body: RegistrationInput) {
  return {
    name: readString(body.name)?.trim(),
    email: normalizeEmail(body.email),
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

  const passwordHash = await hashPassword(password);

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

function normalizeLoginInput(body: LoginInput) {
  return {
    email: normalizeEmail(body.email),
    password: readString(body.password),
  };
}

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(
    normalizeLoginInput((req.body ?? {}) as LoginInput),
  );

  if (!parsed.success) {
    res.status(400).json({
      status: 'error',
      message: 'Validation failed.',
      errors: z.flattenError(parsed.error).fieldErrors,
    });
    return;
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    // passwordHash is selected only to verify the password; it is never returned.
    select: { ...publicUserFields, passwordHash: true },
  });

  // Generic failure for BOTH "unknown email" and "wrong password" so the
  // response never reveals which one was wrong (no account enumeration).
  if (!user) {
    res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
    return;
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);

  if (!passwordMatches) {
    res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
    return;
  }

  // Successful login: issue a JWT inside an HttpOnly cookie (never returned in JSON).
  const token = signAuthToken(user.id);
  res.cookie(AUTH_COOKIE, token, buildCookieOptions());

  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    },
  });
});

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  res.status(200).json({ status: 'success', data: { user: req.authUser } });
});

authRouter.post('/logout', (_req: Request, res: Response) => {
  // Clear the session cookie. No database row is deleted (stateless JWT).
  res.clearCookie(AUTH_COOKIE, buildClearCookieOptions());
  res.status(200).json({ status: 'success', message: 'Logged out.' });
});

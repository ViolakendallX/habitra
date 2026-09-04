/**
 * The shape of a User that is safe to return from the API. `passwordHash` is
 * deliberately excluded, and the list is applied through Prisma's `select` so
 * columns added to the User model later can never leak by accident.
 */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export const publicUserFields = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} as const;

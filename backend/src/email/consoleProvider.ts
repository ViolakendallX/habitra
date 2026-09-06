import type { EmailProvider, SendPasswordResetEmailInput } from './types.js';

/**
 * DEV/TEST ONLY email provider.
 *
 * Instead of delivering mail it captures the last reset URL in memory so local
 * tests can drive the reset flow without a real inbox. The raw token is held in
 * memory ONLY and is intentionally never written to stdout, logs, or disk — it
 * is surfaced for tests exclusively through the dev-only `/api/dev` endpoint
 * (which is not mounted in production).
 */
let lastResetLink: string | null = null;

export function getLastResetLink(): string | null {
  return lastResetLink;
}

export function clearLastResetLink(): void {
  lastResetLink = null;
}

export const consoleEmailProvider: EmailProvider = {
  async sendPasswordResetEmail({ resetUrl }: SendPasswordResetEmailInput) {
    lastResetLink = resetUrl;
  },
};

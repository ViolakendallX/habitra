import { env } from '../config/env.js';

import { consoleEmailProvider } from './consoleProvider.js';
import { createSmtpEmailProvider } from './smtpProvider.js';
import type { EmailProvider } from './types.js';

export type { EmailProvider, SendPasswordResetEmailInput } from './types.js';
export { getLastResetLink } from './consoleProvider.js';

/**
 * Picks the email provider from env:
 *  - EMAIL_PROVIDER=smtp AND SMTP_HOST set  -> real SMTP delivery
 *  - otherwise                               -> dev console capture (no mail sent)
 *
 * The console provider is the safe default for local development because no
 * SMTP credentials are configured yet. See the feature report for what the user
 * must still provide to enable real email.
 */
let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  if (env.emailProvider === 'smtp' && env.smtpHost) {
    cached = createSmtpEmailProvider();
  } else {
    if (env.emailProvider === 'smtp' && !env.smtpHost) {
      console.warn(
        '[email] EMAIL_PROVIDER is "smtp" but SMTP_HOST is not set; falling back to the dev console capture provider (no email will be sent).',
      );
    }
    cached = consoleEmailProvider;
  }

  return cached;
}

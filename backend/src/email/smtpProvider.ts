import nodemailer from 'nodemailer';

import { env } from '../config/env.js';
import type { EmailProvider, SendPasswordResetEmailInput } from './types.js';

/**
 * Production email provider backed by SMTP (via nodemailer).
 *
 * Credentials come from SMTP_* env vars. The reset URL (which contains the raw
 * token) is placed only in the email body — it is never logged.
 */
export function createSmtpEmailProvider(): EmailProvider {
  const transport = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
  });

  return {
    async sendPasswordResetEmail({ to, resetUrl }: SendPasswordResetEmailInput) {
      await transport.sendMail({
        from: env.emailFrom || 'no-reply@habitra.app',
        to,
        subject: 'Reset your Habitra password',
        text: [
          'We received a request to reset your Habitra password.',
          '',
          `Open this link to choose a new password (it expires soon): ${resetUrl}`,
          '',
          'If you did not request this, you can safely ignore this email.',
        ].join('\n'),
        html: [
          '<p>We received a request to reset your Habitra password.</p>',
          `<p><a href="${resetUrl}">Choose a new password</a></p>`,
          '<p>This link expires soon. If you did not request this, you can safely ignore the email.</p>',
        ].join(''),
      });
    },
  };
}

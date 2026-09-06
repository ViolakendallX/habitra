/**
 * Email delivery contract. The password-reset feature depends only on this
 * interface, so the underlying provider (SMTP, a transactional email API, a dev
 * capture sink, ...) can be swapped without touching the routes.
 */
export interface SendPasswordResetEmailInput {
  /** Recipient address (already normalized by the caller). */
  to: string;
  /** Fully-qualified reset URL containing the raw, single-use token. */
  resetUrl: string;
}

export interface EmailProvider {
  sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void>;
}

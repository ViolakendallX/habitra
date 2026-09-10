import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { API_BASE_URL } from '../lib/api';
import { EnvelopeIcon } from '../components/AuthLayout';

/**
 * Forgot Password page.
 *
 * POSTs the user's email to /api/auth/forgot-password. The backend always
 * returns the same generic success message whether or not the account exists,
 * so this page mirrors that: after submit, the user sees a message telling them
 * to check their email. No account-enumeration is possible from the UI.
 *
 * A network failure or non-2xx response is surfaced as an error so the user
 * knows to retry.
 */

type Status = 'idle' | 'loading' | 'success' | 'error';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setStatus('loading');
    setErrorMessage('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (response.ok) {
        setStatus('success');
        return;
      }

      // The backend returns 400 for invalid emails, 429 for rate-limiting.
      let message = 'Something went wrong. Please try again.';
      if (response.status === 429) {
        message = 'Too many requests. Please try again later.';
      } else {
        try {
          const data = await response.json();
          if (data?.message) {
            message = data.message;
          }
        } catch {
          // Response wasn't JSON — use the default error message.
        }
      }

      setStatus('error');
      setErrorMessage(message);
    } catch {
      setStatus('error');
      setErrorMessage('Unable to reach the server. Check your connection and try again.');
    }
  }

  return (
    <>
      <h1 className="auth__hero">
        Reset your <span className="auth__hero-accent">password</span>
      </h1>
      <p className="auth__sub">
        Enter the email on your account and we&apos;ll send you a link to set a
        new password.
      </p>

      <section className="card auth__card">
        <h2 className="auth__card-title">Forgot password</h2>
        <p className="auth__card-sub">We&apos;ll email you a reset link</p>

        {status === 'success' ? (
          <div className="form">
            <div className="alert alert--success">
              If an account exists for that email, we have sent password reset
              instructions. Please check your inbox (and spam folder).
            </div>
            <div className="auth__prompt">
              <Link to="/login" className="form__link">Back to login</Link>
            </div>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            {status === 'error' && (
              <div className="alert alert--error">{errorMessage}</div>
            )}

            <div className="form__group">
              <label className="form__label" htmlFor="email">Email</label>
              <div className="auth__field">
                <span className="auth__field-icon" aria-hidden="true">
                  <EnvelopeIcon />
                </span>
                <input
                  id="email"
                  className="form__input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  disabled={status === 'loading'}
                  required
                />
              </div>
            </div>

            <button
              className="form__btn"
              type="submit"
              disabled={status === 'loading' || email.trim() === ''}
            >
              {status === 'loading' ? 'Sending…' : 'Send reset link'}
            </button>

            <div className="auth__prompt">
              Remembered it?{' '}
              <Link to="/login" className="form__link">Back to login</Link>
            </div>
          </form>
        )}
      </section>
    </>
  );
}

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { API_BASE_URL } from '../lib/api';

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
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra</h1>
        <p className="shell__tagline">Autonomous accountability that remembers.</p>
      </header>

      <section className="card">
        <h2 className="card__title">Forgot your password?</h2>

        {status === 'success' ? (
          <div className="form">
            <div className="alert alert--success">
              If an account exists for that email, we have sent password reset
              instructions. Please check your inbox (and spam folder).
            </div>
            <div className="form__footer">
              <Link to="/login" className="form__link">
                Back to login
              </Link>
            </div>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            <p className="card__text">
              Enter your email address and we'll send you a link to reset your
              password.
            </p>

            {status === 'error' && (
              <div className="alert alert--error">{errorMessage}</div>
            )}

            <div className="form__group">
              <label className="form__label" htmlFor="email">
                Email
              </label>
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

            <button
              className="form__btn"
              type="submit"
              disabled={status === 'loading' || email.trim() === ''}
            >
              {status === 'loading' ? 'Sending…' : 'Send reset link'}
            </button>

            <div className="form__footer">
              <Link to="/login" className="form__link">
                Back to login
              </Link>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

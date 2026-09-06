import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { API_BASE_URL } from '../lib/api';

/**
 * Reset Password page.
 *
 * Reads the raw reset token from the `?token=` query parameter (put there by
 * the email link). The token is never logged or displayed — it is only sent in
 * the POST body to /api/auth/reset-password.
 *
 * Client-side validation: both password fields must match and meet the backend
 * requirement (8–72 characters) before the request is sent. On success, the
 * user is told to sign in with their new password. On failure, a useful error
 * is shown so they know whether to retry or request a new link.
 */

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

type Status = 'idle' | 'loading' | 'success' | 'error';

export default function ResetPassword() {
  // Read the token from the URL once. It is never stored in React state or
  // rendered — it goes straight into the fetch body.
  const token = new URLSearchParams(window.location.search).get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Show a clear message if the reset link is missing the token parameter.
  if (!token) {
    return (
      <main className="shell">
        <header className="shell__header">
          <h1 className="shell__title">Habitra</h1>
          <p className="shell__tagline">Autonomous accountability that remembers.</p>
        </header>

        <section className="card">
          <h2 className="card__title">Reset password</h2>
          <div className="form">
            <div className="alert alert--error">
              This password reset link is invalid or incomplete. Please request
              a new reset link from the forgot password page.
            </div>
            <div className="form__footer">
              <Link to="/forgot-password" className="form__link">
                Request a new reset link
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Client-side validation before hitting the API.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setStatus('error');
      setErrorMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      setStatus('error');
      setErrorMessage(`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`);
      return;
    }
    if (password !== confirmPassword) {
      setStatus('error');
      setErrorMessage('Passwords do not match.');
      return;
    }

    setStatus('loading');
    setErrorMessage('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      if (response.ok) {
        setStatus('success');
        return;
      }

      let message = 'Something went wrong. Please try again.';
      if (response.status === 400) {
        // The backend returns 400 for invalid/expired/used tokens.
        message = 'This reset link is invalid or has expired. Please request a new one.';
      } else if (response.status === 429) {
        message = 'Too many requests. Please try again later.';
      } else {
        try {
          const data = await response.json();
          if (data?.message) {
            message = data.message;
          }
        } catch {
          // Not JSON — use default.
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
        <h2 className="card__title">Reset your password</h2>

        {status === 'success' ? (
          <div className="form">
            <div className="alert alert--success">
              Your password has been reset successfully. You can now sign in
              with your new password.
            </div>
            <div className="form__footer">
              <Link to="/login" className="form__link">
                Go to login
              </Link>
            </div>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            <p className="card__text">
              Choose a new password for your Habitra account.
            </p>

            {status === 'error' && (
              <div className="alert alert--error">{errorMessage}</div>
            )}

            <div className="form__group">
              <label className="form__label" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                className="form__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={status === 'loading'}
                required
              />
              <span className="form__hint">
                At least {MIN_PASSWORD_LENGTH} characters.
              </span>
            </div>

            <div className="form__group">
              <label className="form__label" htmlFor="confirmPassword">
                Confirm new password
              </label>
              <input
                id="confirmPassword"
                className="form__input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={status === 'loading'}
                required
              />
            </div>

            <button
              className="form__btn"
              type="submit"
              disabled={
                status === 'loading' ||
                password === '' ||
                confirmPassword === ''
              }
            >
              {status === 'loading' ? 'Resetting…' : 'Reset password'}
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

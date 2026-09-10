import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { API_BASE_URL } from '../lib/api';
import {
  EyeIcon,
  EyeOffIcon,
  LockIcon,
} from '../components/AuthLayout';

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
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Show a clear message if the reset link is missing the token parameter.
  if (!token) {
    return (
      <>
        <h1 className="auth__hero">
          Invalid <span className="auth__hero-accent">reset link</span>
        </h1>
        <p className="auth__sub">
          This password reset link is missing its token, so it can&apos;t be
          used to set a new password.
        </p>

        <section className="card auth__card">
          <h2 className="auth__card-title">Request a new link</h2>
          <p className="auth__card-sub">
            Go back to the forgot password page to receive a fresh reset email.
          </p>
          <div className="form">
            <div className="alert alert--error">
              This password reset link is invalid or incomplete. Please request
              a new reset link from the forgot password page.
            </div>
            <div className="auth__prompt">
              <Link to="/forgot-password" className="form__link">
                Request a new reset link
              </Link>
            </div>
          </div>
        </section>
      </>
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
    <>
      <h1 className="auth__hero">
        Set a new <span className="auth__hero-accent">password</span>
      </h1>
      <p className="auth__sub">
        Choose a new password for your Habitra account.
      </p>

      <section className="card auth__card">
        <h2 className="auth__card-title">Reset password</h2>
        <p className="auth__card-sub">Enter your new password below</p>

        {status === 'success' ? (
          <div className="form">
            <div className="alert alert--success">
              Your password has been reset successfully. You can now sign in
              with your new password.
            </div>
            <div className="auth__prompt">
              <Link to="/login" className="form__link">Go to login</Link>
            </div>
          </div>
        ) : (
          <form className="form" onSubmit={handleSubmit}>
            {status === 'error' && (
              <div className="alert alert--error">{errorMessage}</div>
            )}

            <div className="form__group">
              <label className="form__label" htmlFor="password">New password</label>
              <div className="auth__field auth__field--with-toggle">
                <span className="auth__field-icon" aria-hidden="true">
                  <LockIcon />
                </span>
                <input
                  id="password"
                  className="form__input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                  autoComplete="new-password"
                  disabled={status === 'loading'}
                  required
                />
                <button
                  type="button"
                  className="auth__field-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            <div className="form__group">
              <label className="form__label" htmlFor="confirmPassword">Confirm new password</label>
              <div className="auth__field auth__field--with-toggle">
                <span className="auth__field-icon" aria-hidden="true">
                  <LockIcon />
                </span>
                <input
                  id="confirmPassword"
                  className="form__input"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your new password"
                  autoComplete="new-password"
                  disabled={status === 'loading'}
                  required
                />
                <button
                  type="button"
                  className="auth__field-toggle"
                  onClick={() => setShowConfirmPassword((value) => !value)}
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showConfirmPassword}
                >
                  {showConfirmPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
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

            <div className="auth__prompt">
              <Link to="/login" className="form__link">Back to login</Link>
            </div>
          </form>
        )}
      </section>
    </>
  );
}

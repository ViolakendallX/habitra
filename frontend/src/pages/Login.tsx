import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import type { UserResponse } from '../lib/types';
import {
  EnvelopeIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
} from '../components/AuthLayout';

/**
 * Login page.
 *
 * POSTs to /api/auth/login. The backend answers with the public user profile
 * and sets the session as an HttpOnly cookie — the JWT is never in the response
 * body and is never readable here, so this page only ever handles the profile.
 *
 * After a successful login the session is re-read through the auth context
 * (GET /api/auth/me) so the signed-in state comes from the cookie that actually
 * reached the browser, and then the user is sent to /dashboard.
 *
 * The backend returns the same generic "Invalid email or password." for both an
 * unknown address and a wrong password, and this page shows that message
 * verbatim so the UI cannot be used to enumerate accounts.
 */

type Status = 'idle' | 'loading' | 'error';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const { refreshUser } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setStatus('loading');
    setErrorMessage('');

    try {
      await api.post<UserResponse>('/auth/login', {
        email: email.trim(),
        password,
      });

      // The cookie is set by the server; confirm it before entering the app.
      const user = await refreshUser();

      if (!user) {
        setStatus('error');
        setErrorMessage('We could not start your session. Please try again.');
        return;
      }

      navigate('/dashboard', { replace: true });
    } catch (error) {
      setStatus('error');

      if (!isApiError(error)) {
        setErrorMessage('Unable to reach the server. Check your connection and try again.');
        return;
      }

      // Prefer a specific field message for validation failures; otherwise the
      // server's own message (401 is already the generic one for bad credentials).
      setErrorMessage(
        error.fieldError('email')
          ?? error.fieldError('password')
          ?? error.message,
      );
    }
  }

  return (
    <>
      <h1 className="auth__hero">
        Welcome <span className="auth__hero-accent">back</span>
      </h1>
      <p className="auth__sub">
        Log in to your Habitra account and keep building a better you.
      </p>

      <section className="card auth__card">
        <h2 className="auth__card-title">Sign in</h2>
        <p className="auth__card-sub">Enter your details to continue</p>

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

          <div className="form__group">
            <label className="form__label" htmlFor="password">Password</label>
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
                placeholder="Enter your password"
                autoComplete="current-password"
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

          <div className="auth__forgot">
            <Link to="/forgot-password" className="form__link">
              Forgot password?
            </Link>
          </div>

          <button
            className="form__btn"
            type="submit"
            disabled={
              status === 'loading' || email.trim() === '' || password === ''
            }
          >
            {status === 'loading' ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="auth__divider" role="separator">or</div>

          <div className="auth__prompt">
            Don&apos;t have an account?{' '}
            <Link to="/register" className="form__link">Sign up</Link>
          </div>
        </form>
      </section>
    </>
  );
}

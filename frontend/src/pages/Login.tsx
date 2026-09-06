import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import type { UserResponse } from '../lib/types';

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
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra</h1>
        <p className="shell__tagline">Autonomous accountability that remembers.</p>
      </header>

      <section className="card">
        <h2 className="card__title">Sign in</h2>

        <form className="form" onSubmit={handleSubmit}>
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

          <div className="form__group">
            <label className="form__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="form__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={status === 'loading'}
              required
            />
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

          <div className="form__footer">
            <Link to="/forgot-password" className="form__link">
              Forgot password?
            </Link>
          </div>

          <div className="form__footer">
            <Link to="/register" className="form__link">
              Don't have an account? Sign up
            </Link>
          </div>
        </form>
      </section>
    </main>
  );
}

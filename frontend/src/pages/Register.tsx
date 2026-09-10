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
  UserIcon,
} from '../components/AuthLayout';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

type Status = 'idle' | 'loading' | 'error';

type FieldErrors = {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
};

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateForm(input: {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}): FieldErrors {
  const errors: FieldErrors = {};

  if (input.name.trim() === '') {
    errors.name = 'Name is required.';
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  if (normalizedEmail === '') {
    errors.email = 'Email is required.';
  } else if (!isLikelyEmail(normalizedEmail)) {
    errors.email = 'Enter a valid email address.';
  }

  if (input.password.length === 0) {
    errors.password = 'Password is required.';
  } else if (input.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (input.password.length > MAX_PASSWORD_LENGTH) {
    errors.password = `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  }

  if (input.confirmPassword.length === 0) {
    errors.confirmPassword = 'Please confirm your password.';
  } else if (input.password !== input.confirmPassword) {
    errors.confirmPassword = 'Passwords do not match.';
  }

  return errors;
}

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const { refreshUser } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextFieldErrors = validateForm({
      name,
      email,
      password,
      confirmPassword,
    });

    if (Object.keys(nextFieldErrors).length > 0) {
      setStatus('error');
      setErrorMessage('Please fix the highlighted fields.');
      setFieldErrors(nextFieldErrors);
      return;
    }

    setStatus('loading');
    setErrorMessage('');
    setFieldErrors({});

    const normalizedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();

    try {
      await api.post<UserResponse>('/auth/register', {
        name: normalizedName,
        email: normalizedEmail,
        password,
      });

      // Registration endpoint creates the user profile; login endpoint sets the
      // HttpOnly cookie used by the existing AuthContext/me flow.
      await api.post<UserResponse>('/auth/login', {
        email: normalizedEmail,
        password,
      });

      const user = await refreshUser();
      if (!user) {
        setStatus('error');
        setErrorMessage('Your account was created, but we could not start your session. Please sign in.');
        return;
      }

      navigate('/dashboard', { replace: true });
    } catch (error) {
      setStatus('error');

      if (!isApiError(error)) {
        setErrorMessage('Unable to reach the server. Check your connection and try again.');
        return;
      }

      if (error.status === 409) {
        setErrorMessage('An account with this email already exists. Try signing in instead.');
        return;
      }

      const backendFieldErrors: FieldErrors = {
        name: error.fieldError('name'),
        email: error.fieldError('email'),
        password: error.fieldError('password'),
      };

      if (backendFieldErrors.name || backendFieldErrors.email || backendFieldErrors.password) {
        setFieldErrors(backendFieldErrors);
      }

      setErrorMessage(error.message || 'Unable to create account right now. Please try again.');
    }
  }

  return (
    <>
      <h1 className="auth__hero">
        Create your <span className="auth__hero-accent">account</span>
      </h1>
      <p className="auth__sub">
        Join Habitra to build habits that actually stick, with an AI that keeps
        you honest.
      </p>

      <section className="card auth__card">
        <h2 className="auth__card-title">Sign up</h2>
        <p className="auth__card-sub">Start your accountability journey</p>

        <form className="form" onSubmit={handleSubmit} noValidate>
          {status === 'error' && errorMessage && (
            <div className="alert alert--error">{errorMessage}</div>
          )}

          <div className="form__group">
            <label className="form__label" htmlFor="name">Name</label>
            <div className="auth__field">
              <span className="auth__field-icon" aria-hidden="true">
                <UserIcon />
              </span>
              <input
                id="name"
                className={`form__input ${fieldErrors.name ? 'form__input--error' : ''}`}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
                disabled={status === 'loading'}
                required
              />
            </div>
            {fieldErrors.name && <span className="form__error-text">{fieldErrors.name}</span>}
          </div>

          <div className="form__group">
            <label className="form__label" htmlFor="email">Email</label>
            <div className="auth__field">
              <span className="auth__field-icon" aria-hidden="true">
                <EnvelopeIcon />
              </span>
              <input
                id="email"
                className={`form__input ${fieldErrors.email ? 'form__input--error' : ''}`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                disabled={status === 'loading'}
                required
              />
            </div>
            {fieldErrors.email && <span className="form__error-text">{fieldErrors.email}</span>}
          </div>

          <div className="form__group">
            <label className="form__label" htmlFor="password">Password</label>
            <div className="auth__field auth__field--with-toggle">
              <span className="auth__field-icon" aria-hidden="true">
                <LockIcon />
              </span>
              <input
                id="password"
                className={`form__input ${fieldErrors.password ? 'form__input--error' : ''}`}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters`}
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
            {fieldErrors.password && <span className="form__error-text">{fieldErrors.password}</span>}
          </div>

          <div className="form__group">
            <label className="form__label" htmlFor="confirmPassword">Confirm password</label>
            <div className="auth__field auth__field--with-toggle">
              <span className="auth__field-icon" aria-hidden="true">
                <LockIcon />
              </span>
              <input
                id="confirmPassword"
                className={`form__input ${fieldErrors.confirmPassword ? 'form__input--error' : ''}`}
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your password"
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
            {fieldErrors.confirmPassword && (
              <span className="form__error-text">{fieldErrors.confirmPassword}</span>
            )}
          </div>

          <button
            className="form__btn"
            type="submit"
            disabled={status === 'loading'}
          >
            {status === 'loading' ? 'Creating account…' : 'Create account'}
          </button>

          <div className="auth__divider" role="separator">or</div>

          <div className="auth__prompt">
            Already have an account?{' '}
            <Link to="/login" className="form__link">Sign in</Link>
          </div>
        </form>
      </section>
    </>
  );
}

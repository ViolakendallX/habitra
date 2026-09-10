import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * AuthLayout — the dark premium frame for every public authentication page.
 *
 * Mirrors `AppLayout` (which frames the protected screens): on mount it sets
 * `body[data-theme="dark"]` so the existing token overrides in global.css paint
 * the surface/border/text/alert variables in the dark palette, and clears the
 * attribute on unmount so the light theme returns when the user signs in and
 * the protected AppLayout takes over. Every public route renders through this
 * layout, and the dark theme never leaks onto the auth pages and never bleeds
 * onto the rest of the app.
 *
 * Renders:
 *   - A top brand bar: Habitra leaf tile + wordmark on the left, three quiet
 *     tagline pills on the right (hidden on narrow screens).
 *   - Two soft purple ambient glows anchored to the lower left and right.
 *   - A centered column where each page drops its own hero + form card.
 *   - A quiet bottom footer with the Habitra tagline.
 *
 * The auth logic (form submit, validation, error mapping, navigation) is
 * unchanged — this component only paints the chrome.
 */

export function HabitraLeaf() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M20 4C11 4 4 11 4 20c9 0 16-7 16-16Z"
        fill="currentColor"
      />
      <path
        d="M20 4 4 20"
        stroke="rgba(255,255,255,0.55)"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function EnvelopeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="m3 8 9 6 9-6" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function UserIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
      <path d="M9.9 4.6A10 10 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-3.1 4.3" />
      <path d="M6.6 6.6A13 13 0 0 0 2 11s3.5 7 10 7a10 10 0 0 0 4-.8" />
    </svg>
  );
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.dataset.theme = 'dark';
    return () => {
      delete document.body.dataset.theme;
    };
  }, []);

  return (
    <div className="auth">
      <header className="auth__bar">
        <Link to="/" className="auth__brand">
          <span className="auth__brand-mark" aria-hidden="true">
            <HabitraLeaf />
          </span>
          <span className="auth__brand-name">Habitra</span>
        </Link>
        <div className="auth__pills" aria-label="Habitra highlights">
          <span>Build better you</span>
          <span className="auth__pill-sep" aria-hidden="true">·</span>
          <span>Powered by AI</span>
          <span className="auth__pill-sep" aria-hidden="true">·</span>
          <span>Onchain rewards</span>
        </div>
      </header>

      <main className="auth__main">{children}</main>

      <footer className="auth__footer">
        <span>Habitra</span>
        <span className="auth__footer-sep" aria-hidden="true">·</span>
        <span>Autonomous accountability that remembers.</span>
      </footer>
    </div>
  );
}

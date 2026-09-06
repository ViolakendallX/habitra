import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';

/**
 * Gates a route on "is there a session".
 *
 * Authentication only — there is no role or permission model at this stage.
 *
 * While the initial /api/auth/me call is in flight it renders the same minimal
 * loading card instead of the page, so a protected screen never flashes before
 * the session is known and never gets a chance to fire its own requests with an
 * unconfirmed session.
 */

function AuthLoading() {
  return (
    <main className="shell">
      <section className="card">
        <p className="card__text">Loading…</p>
      </section>
    </main>
  );
}

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

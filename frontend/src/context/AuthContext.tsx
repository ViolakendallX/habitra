import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api, isApiError } from '../lib/http';
import type { User, UserResponse } from '../lib/types';

/**
 * Session state for the whole app.
 *
 * The session is the backend's HttpOnly JWT cookie. It is never readable from
 * JavaScript, so this context holds only the *public user profile* returned by
 * GET /api/auth/me — no token, and nothing written to localStorage or
 * sessionStorage. Dropping the cookie (logout, expiry, a different browser) is
 * what actually ends the session; this state just mirrors it.
 *
 * A 401 from /me is the normal "not signed in" answer, not an error worth
 * surfacing. Anything else (network down, 500) is treated as "unknown", and we
 * fail closed — no user — so protected routes send the visitor to /login rather
 * than rendering with a session we could not confirm.
 */

export interface AuthContextValue {
  /** The signed-in user's public profile, or null when there is no session. */
  user: User | null;
  /** True until the initial /api/auth/me call has been resolved. */
  loading: boolean;
  isAuthenticated: boolean;
  /** Re-reads the session from the server and updates `user`. */
  refreshUser: () => Promise<User | null>;
  /** Ends the server session, then clears local state. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async (): Promise<User | null> => {
    try {
      const data = await api.get<UserResponse>('/auth/me');
      const nextUser = data?.user ?? null;
      setUser(nextUser);
      return nextUser;
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        setUser(null);
        return null;
      }

      // Unknown failure: fail closed. Deliberately does not log the error
      // object, which could carry request details into the console.
      console.warn('[habitra] Could not confirm the session; treating as signed out.');
      setUser(null);
      return null;
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.message('/auth/logout', { method: 'POST' });
    } catch {
      // Clearing local state still happens below: the cookie may already be
      // gone, and the UI must never keep showing a signed-in user.
    } finally {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let active = true;

    void refreshUser().finally(() => {
      if (active) {
        setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [refreshUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAuthenticated: user !== null,
      refreshUser,
      logout,
    }),
    [user, loading, refreshUser, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }

  return context;
}

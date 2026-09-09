import { useState, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

/**
 * Navigation bar for authenticated (protected) pages.
 *
 * It is rendered once per protected screen via the AppLayout wrapper in App.tsx,
 * so it never appears on the public auth pages (login, register, forgot/reset
 * password). The active link is highlighted with NavLink's `isActive`, which
 * matches on the leading path segment so `/challenges/:id` still lights
 * "Challenges".
 *
 * Logout uses the existing auth flow: `useAuth().logout()` POSTs to
 * /api/auth/logout (clearing the HttpOnly session cookie) and then drops the
 * local user, which ProtectedRoute turns into a redirect to /login.
 */

/** Routes shown in the bar, in display order. Wallet/Settings/Dashboard are
 * linked even though those pages are not built yet — clicking them currently
 * lands on the app's catch-all redirect until their pages exist. */
const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/habits', label: 'Habits' },
  { to: '/challenges', label: 'Challenges' },
  { to: '/agent', label: 'Agent' },
  { to: '/wallet', label: 'Wallet' },
  { to: '/settings', label: 'Settings' },
] as const;

export default function Navigation() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loggingOut) return;

    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <nav className="navbar" aria-label="Primary">
      <div className="navbar__inner">
        <NavLink to="/dashboard" className="navbar__brand">
          Habitra
        </NavLink>

        <ul className="navbar__links">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  isActive ? 'navbar__link navbar__link--active' : 'navbar__link'
                }
                // Light up the parent section when on a nested route, e.g.
                // /challenges/:id should keep "Challenges" active.
                end={item.to === '/dashboard'}
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="navbar__account">
          <NotificationBell />
          {user && <span className="navbar__user">{user.name}</span>}
          <form className="navbar__logout" onSubmit={handleLogout}>
            <button
              className="btn btn--ghost"
              type="submit"
              disabled={loggingOut}
            >
              {loggingOut ? 'Signing out…' : 'Log out'}
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}

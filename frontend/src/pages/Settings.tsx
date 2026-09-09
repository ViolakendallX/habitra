import { useState, type FormEvent } from 'react';

import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';

/**
 * Settings — notification preferences plus read-only account info.
 *
 * The two toggles are this device's only stored state (see
 * NotificationContext): they are preferences, never account data, so nothing
 * here needs a backend round trip. Account details come from the session's
 * existing public profile and cannot be edited here.
 *
 * Deliberately absent: profile editing, account deletion, Telegram, and
 * blockchain keys — none of them exist in this app.
 */

export default function Settings() {
  const { user, logout } = useAuth();
  const { enabled, soundEnabled, setEnabled, setSoundEnabled } = useNotifications();
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
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Settings</h1>
        <p className="shell__tagline">Control what Habitra tells you, and how.</p>
      </header>

      <section className="card">
        <h2 className="card__title">Notifications</h2>
        <p className="card__text">
          Notifications appear in the bell at the top of the app while you are
          signed in. Nothing is sent by email, SMS or push.
        </p>

        <div className="settings__toggles">
          <label className="settings__toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>
              <strong>Notifications</strong>
              <span className="settings__hint">
                Open habits, challenge risk and accountability nudges.
              </span>
            </span>
          </label>

          <label className="settings__toggle">
            <input
              type="checkbox"
              checked={soundEnabled}
              disabled={!enabled}
              onChange={(event) => setSoundEnabled(event.target.checked)}
            />
            <span>
              <strong>Notification sound</strong>
              <span className="settings__hint">
                A short chime when something new appears.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Account</h2>

        <dl className="settings__rows">
          <div className="settings__row">
            <dt>Name</dt>
            <dd>{user?.name ?? '—'}</dd>
          </div>
          <div className="settings__row">
            <dt>Email</dt>
            <dd>{user?.email ?? '—'}</dd>
          </div>
        </dl>

        <form className="settings__logout" onSubmit={handleLogout}>
          <button className="btn btn--ghost" type="submit" disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Log out'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="card__title">About</h2>
        <p className="card__text">
          <strong>Habitra</strong> — Autonomous accountability that remembers.
        </p>
      </section>
    </main>
  );
}

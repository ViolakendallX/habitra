import { Link } from 'react-router-dom';

/**
 * Login page.
 *
 * The full login form is not implemented yet. However, the "Forgot password?"
 * link is already wired so the password-reset flow is reachable from the login
 * page.
 */
export default function Login() {
  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra</h1>
        <p className="shell__tagline">Autonomous accountability that remembers.</p>
      </header>

      <section className="card">
        <h2 className="card__title">Sign in</h2>
        <p className="card__text">Login — not implemented yet.</p>
        <div className="form__footer">
          <Link to="/forgot-password" className="form__link">
            Forgot password?
          </Link>
        </div>
      </section>
    </main>
  );
}

import { PLANNED_ROUTES } from './lib/routes';

export default function App() {
  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra</h1>
        <p className="shell__tagline">Autonomous accountability that remembers.</p>
      </header>

      <section className="card">
        <h2 className="card__title">Frontend foundation ready</h2>
        <p className="card__text">
          This is the Stage 1 foundation: React + Vite + TypeScript only. No
          application features are implemented yet.
        </p>
        <ul className="card__list">
          {PLANNED_ROUTES.map((route) => (
            <li key={route}>{route}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { PLANNED_ROUTES } from './lib/routes';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Habits from './pages/Habits';
import Challenges from './pages/Challenges';
import Agent from './pages/Agent';
import Settings from './pages/Settings';

/**
 * Root application component.
 *
 * React Router is wired here so every planned route (PRD section 4) resolves to
 * a page. Routes marked "not implemented yet" keep their stub components; the
 * auth pages (login, register, forgot-password, reset-password) are functional.
 *
 * The list below renders the planned routes as informational text inside the
 * shell card so the foundation state is still visible at `/`.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomeStub />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/habits" element={<Habits />} />
        <Route path="/challenges" element={<Challenges />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Placeholder home page shown at `/` — keeps the original foundation card. */
function HomeStub() {
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

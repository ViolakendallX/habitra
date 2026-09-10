import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';

import { AuthProvider } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import ProtectedRoute from './components/ProtectedRoute';
import Navigation from './components/Navigation';
import AuthLayout from './components/AuthLayout';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Habits from './pages/Habits';
import Challenges from './pages/Challenges';
import Agent from './pages/Agent';
import Wallet from './pages/Wallet';
import Settings from './pages/Settings';

/**
 * Root application component.
 *
 * React Router is wired here so every planned route (PRD section 4) resolves to
 * a page. `AuthProvider` sits above the routes and resolves the session once,
 * via GET /api/auth/me, before anything protected renders.
 *
 * `NotificationProvider` sits just below it: it needs the session to know
 * whether to read anything, and it must wrap the routes so every page — and the
 * bell in the navbar — shares one notification list.
 *
 * Public routes — login, register, forgot-password, reset-password — stay
 * reachable without a session so the password-reset flow always works. The five
 * app routes are wrapped in ProtectedRoute, which sends signed-out visitors to
 * /login.
 *
 * The root path `/` sends visitors to `/dashboard`; ProtectedRoute then keeps
 * unauthenticated users on the public `/login` screen.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NotificationProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route
              path="/login"
              element={
                <AuthLayout>
                  <Login />
                </AuthLayout>
              }
            />
            <Route
              path="/register"
              element={
                <AuthLayout>
                  <Register />
                </AuthLayout>
              }
            />
            <Route
              path="/forgot-password"
              element={
                <AuthLayout>
                  <ForgotPassword />
                </AuthLayout>
              }
            />
            <Route
              path="/reset-password"
              element={
                <AuthLayout>
                  <ResetPassword />
                </AuthLayout>
              }
            />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Dashboard />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/habits"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Habits />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/challenges"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Challenges />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/agent"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Agent />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/wallet"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Wallet />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Settings />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * Wrapper for every protected screen. Renders the shared Navigation above the
 * page content and leaves the page to render its own <main className="shell">.
 * Only used inside ProtectedRoute, so the nav never appears on the public auth
 * pages.
 *
 * The dark / near-black + lavender theme is scoped here: flipping
 * `body[data-theme]` on mount (and clearing it on unmount) repaints the navbar,
 * the notification bell, and every protected page through the token overrides in
 * global.css. The public auth pages render outside this layout, so they stay
 * light. The change is fully reversible — sign out (or hit a public route) and
 * the attribute is deleted, returning the light theme.
 */
function AppLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.dataset.theme = 'dark';

    return () => {
      delete document.body.dataset.theme;
    };
  }, []);

  return (
    <>
      <Navigation />
      {children}
    </>
  );
}

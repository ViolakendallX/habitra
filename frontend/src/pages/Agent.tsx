import { useMemo, useState } from 'react';

import { useNotifications } from '../context/NotificationContext';
import { NETWORK_ERROR_STATUS, api, isApiError } from '../lib/http';
import type { AgentRecommendation, AgentRecommendationResponse } from '../lib/types';

type LoadState = 'idle' | 'loading' | 'success' | 'error';

function friendlyTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function errorMessageFor(error: unknown): string {
  if (!isApiError(error)) {
    return 'Something went wrong. Please try again.';
  }

  if (error.status === 503) {
    return 'The agent is not configured yet.';
  }

  if (error.status === 502) {
    return 'Habitra could not generate a recommendation right now. Please try again.';
  }

  if (error.status === NETWORK_ERROR_STATUS) {
    return 'Unable to reach the server. Check your connection and try again.';
  }

  if (error.status === 401) {
    // ProtectedRoute/AuthContext already handles session redirects; keep this
    // message graceful in case the request races an expired session.
    return 'Your session has expired. Please sign in again.';
  }

  return error.message || 'Something went wrong. Please try again.';
}

export default function Agent() {
  const { registerAgentRecommendation } = useNotifications();
  const [state, setState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [recommendation, setRecommendation] = useState<AgentRecommendation | null>(null);

  const memorySignal = useMemo(() => {
    if (!recommendation) return null;
    return recommendation.memoryUsed
      ? 'Based on what Habitra remembers about your recent behavior.'
      : 'Generated from your current habit data (no remembered context used this time).';
  }, [recommendation]);

  async function fetchRecommendation() {
    setState('loading');
    setErrorMessage('');

    try {
      const data = await api.get<AgentRecommendationResponse>('/agent/recommendation');
      const next = data?.recommendation;

      if (!next) {
        setState('error');
        setErrorMessage('Habitra returned an incomplete recommendation. Please try again.');
        return;
      }

      setRecommendation(next);
      // Reuses the response already in hand; does not trigger another call.
      registerAgentRecommendation(next);
      setState('success');
    } catch (error) {
      setState('error');
      setErrorMessage(errorMessageFor(error));
    }
  }

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra Agent</h1>
        <p className="shell__tagline">
          Habitra analyzes your habits, recent behavior, and remembered context to suggest your next best accountability action.
        </p>
      </header>

      <section className="card agent-card">
        <div className="agent-card__controls">
          <button
            className="form__btn"
            type="button"
            onClick={fetchRecommendation}
            disabled={state === 'loading'}
          >
            {state === 'loading' ? 'Habitra is thinking...' : 'Get my recommendation'}
          </button>

          {state === 'loading' && (
            <p className="agent-card__loading">Habitra is thinking...</p>
          )}
        </div>

        {state === 'error' && (
          <div className="agent-card__error">
            <div className="alert alert--error">{errorMessage}</div>
            {/* No `disabled` here: inside the error branch `state` is already
                narrowed to 'error', so a loading check would be dead code.
                Retry is intentionally always clickable. */}
            <button
              className="btn"
              type="button"
              onClick={fetchRecommendation}
            >
              Retry
            </button>
          </div>
        )}

        {recommendation && (state === 'success' || state === 'error') && (
          <article className="agent-result">
            <h2 className="card__title">Your recommendation</h2>

            <div className="agent-result__row">
              <h3 className="agent-result__label">Message</h3>
              <p className="agent-result__text">{recommendation.message}</p>
            </div>

            <div className="agent-result__row">
              <h3 className="agent-result__label">Recommendation</h3>
              <p className="agent-result__text">{recommendation.recommendation}</p>
            </div>

            <div className="agent-result__row">
              <h3 className="agent-result__label">Reason</h3>
              <p className="agent-result__text">{recommendation.reason}</p>
            </div>

            <div className="agent-result__meta">
              <span className={`badge ${recommendation.memoryUsed ? 'badge--ok' : 'badge--miss'}`}>
                {recommendation.memoryUsed ? 'Memory used' : 'Memory not used'}
              </span>
              <span className="agent-result__memory-note">{memorySignal}</span>
            </div>

            <p className="agent-result__time">Generated: {friendlyTime(recommendation.generatedAt)}</p>
          </article>
        )}
      </section>
    </main>
  );
}

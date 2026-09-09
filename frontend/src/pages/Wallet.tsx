import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { NETWORK_ERROR_STATUS, api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import type { BlockchainStatus, Wallet, WalletResponse } from '../lib/types';

/**
 * Wallet page — surfaces the existing Base + BEES backend foundation.
 *
 * It only calls the three endpoints that already exist:
 *   GET  /api/wallet            -> the signed-in user's wallet (or null)
 *   POST /api/wallet            -> link a public EVM address
 *   GET  /api/blockchain/status -> public chain configuration (no secrets)
 *
 * It performs NO on-chain transaction and touches no contract. Only a *public*
 * address is ever sent or displayed: the backend Wallet model has no
 * private-key/seed/secret field, and the input warns against entering one.
 *
 * Ownership is entirely server-side — no request carries a userId, and the
 * session cookie is attached by lib/http.ts and never read here.
 */

/** Base Sepolia. Mirrors the backend's DEFAULT_CHAIN_ID. */
const DEFAULT_CHAIN_ID = 84532;

function chainName(chainId: number): string {
  if (chainId === DEFAULT_CHAIN_ID) return 'Base Sepolia';
  return `Chain ${chainId}`;
}

function formatWhen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function messageFor(error: unknown): string {
  if (!isApiError(error)) {
    return 'Something went wrong. Please try again.';
  }

  if (error.status === NETWORK_ERROR_STATUS) {
    return 'Unable to reach the server. Check your connection and try again.';
  }

  if (error.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }

  if (error.status === 409) {
    return 'This wallet address is already linked to another Habitra account.';
  }

  return error.message || 'Something went wrong. Please try again.';
}

function modeBadgeClass(mode: BlockchainStatus['mode']): string {
  if (mode === 'live') return 'badge badge--ok';
  if (mode === 'unconfigured') return 'badge badge--miss';
  return 'badge';
}

export default function Wallet() {
  const { user } = useAuth();

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [status, setStatus] = useState<BlockchainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [addressError, setAddressError] = useState('');
  const [chainError, setChainError] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');

    try {
      const [walletData, statusData] = await Promise.all([
        api.get<WalletResponse>('/wallet'),
        api.get<BlockchainStatus>('/blockchain/status'),
      ]);

      setWallet(walletData?.wallet ?? null);
      setStatus(statusData ?? null);
    } catch (error) {
      setWallet(null);
      setStatus(null);
      setLoadError(messageFor(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function connectWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = address.trim();

    if (!trimmed) {
      setAddressError('Wallet address is required.');
      return;
    }

    setSubmitting(true);
    setFormError('');
    setAddressError('');
    setChainError('');
    setBanner(null);

    try {
      // The server validates the EVM address and the chain. Base Sepolia is the
      // only supported chain today, so the default is sent explicitly.
      const created = await api.post<WalletResponse>('/wallet', {
        address: trimmed,
        chainId: DEFAULT_CHAIN_ID,
      });

      setWallet(created?.wallet ?? null);
      setAddress('');
      setFormOpen(false);
      setBanner({ kind: 'success', text: 'Wallet connected.' });
    } catch (error) {
      if (isApiError(error)) {
        // 400s carry per-field messages (address / chainId); anything else is
        // surfaced as a form-level message (401 session, 409 already linked).
        const addrMessage = error.fieldError('address');
        const chainMessage = error.fieldError('chainId');

        if (addrMessage) setAddressError(addrMessage);
        if (chainMessage) setChainError(chainMessage);
        if (!addrMessage && !chainMessage) setFormError(messageFor(error));
      } else {
        setFormError(messageFor(error));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Chain actually in use: the connected wallet's chain, else the backend default.
  const activeChainId = wallet?.chainId ?? status?.defaultChainId ?? DEFAULT_CHAIN_ID;
  const showForm = !wallet || formOpen;

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">Habitra Wallet</h1>
        <p className="shell__tagline">
          Link a public wallet on Base Sepolia. No on-chain transactions yet.
        </p>
        {user && <p className="habits__user">Signed in as {user.name}</p>}
      </header>

      {banner && (
        <div className={banner.kind === 'success' ? 'alert alert--success' : 'alert alert--error'}>
          {banner.text}
        </div>
      )}

      <section className="card">
        <h2 className="card__title">Connected wallet</h2>

        {loading && <p className="habits__muted">Loading your wallet…</p>}

        {!loading && loadError && (
          <div className="habits__error">
            <div className="alert alert--error">{loadError}</div>
            <button className="btn btn--primary" type="button" onClick={() => void loadAll()}>
              Try again
            </button>
          </div>
        )}

        {!loading && !loadError && !wallet && (
          <p className="habits__muted">
            No wallet connected yet. Use the form below to link one.
          </p>
        )}

        {!loading && !loadError && wallet && (
          <>
            <div className="wallet__detail">
              <p className="wallet__label">Address</p>
              <p className="wallet__address">{wallet.address}</p>

              <p className="wallet__label">Chain</p>
              <p className="wallet__value">
                {chainName(wallet.chainId)} ({wallet.chainId})
              </p>

              <p className="wallet__label">Linked</p>
              <p className="wallet__value">{formatWhen(wallet.createdAt)}</p>
            </div>

            {!formOpen && (
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => setFormOpen(true)}
              >
                Connect a different wallet
              </button>
            )}
          </>
        )}
      </section>

      {showForm && (
        <section className="card">
          <h2 className="card__title">{wallet ? 'Connect a different wallet' : 'Connect wallet'}</h2>

          <form className="form" onSubmit={connectWallet} noValidate>
            {formError && <div className="alert alert--error">{formError}</div>}

            <div className="form__group">
              <label className="form__label" htmlFor="wallet-address">
                Public wallet address
              </label>
              <input
                id="wallet-address"
                className={`form__input ${addressError ? 'form__input--error' : ''}`}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                disabled={submitting}
                required
              />
              <span className="form__hint">
                A public EVM address on {chainName(DEFAULT_CHAIN_ID)} ({DEFAULT_CHAIN_ID}).
                Never enter a private key or seed phrase.
              </span>
              {addressError && <span className="form__error-text">{addressError}</span>}
            </div>

            {chainError && (
              <div className="alert alert--error">{chainError}</div>
            )}

            <div className="habits__form-actions">
              <button className="form__btn" type="submit" disabled={submitting}>
                {submitting ? 'Connecting…' : 'Connect wallet'}
              </button>

              {wallet && (
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => {
                    setFormOpen(false);
                    setAddress('');
                    setAddressError('');
                    setChainError('');
                    setFormError('');
                  }}
                  disabled={submitting}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      <section className="card">
        <h2 className="card__title">Blockchain status</h2>

        {loading && <p className="habits__muted">Loading blockchain status…</p>}

        {!loading && !loadError && !status && (
          <p className="habits__muted">Blockchain status is unavailable.</p>
        )}

        {!loading && !loadError && status && (
          <>
            <p className="wallet__mode">
              <span className={modeBadgeClass(status.mode)}>{status.mode}</span>
              <span>{status.note}</span>
            </p>

            <div className="wallet__grid">
              <p>
                <strong>Chain:</strong> {chainName(activeChainId)} ({activeChainId})
              </p>
              <p>
                <strong>Configured chain ID:</strong> {status.chainId}
              </p>
              <p>
                <strong>Supported chains:</strong> {status.supportedChainIds.join(', ')}
              </p>
              <p>
                <strong>RPC URL:</strong> {status.rpcUrl ?? 'not configured'}
              </p>
              <p>
                <strong>BEES token:</strong> {status.beesTokenAddress ?? 'not deployed'}
              </p>
              <p>
                <strong>Challenge contract:</strong>{' '}
                {status.challengeContractAddress ?? 'not deployed'}
              </p>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Transaction history</h2>
        <p className="habits__muted">
          Not available yet — the backend does not expose a transaction-history
          endpoint, so nothing is fetched or invented here. Transaction records
          already exist in the database, but no on-chain transactions are
          performed at this stage.
        </p>
      </section>
    </main>
  );
}

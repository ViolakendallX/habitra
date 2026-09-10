import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Address } from 'viem';

import { NETWORK_ERROR_STATUS, api, isApiError } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import type { BlockchainStatus, Wallet, WalletResponse } from '../lib/types';
import { formatBeesAmount, readBeesBalance } from '../lib/wallet/bees';
import {
  FAUCET_CLAIM_LABEL,
  claimBees,
  claimBeesServer,
  readFaucetClaimed,
} from '../lib/wallet/faucet';
import {
  getInjectedProvider,
  getWalletChainId,
  isBaseSepolia,
  isInjectedWalletAvailable,
  readAuthorizedAccounts,
  requestWalletAccounts,
} from '../lib/wallet/injectedWallet';

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

/** `0x1234abcd…5678` — enough to recognise a hash, short enough to fit. */
function shortHex(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
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

/** EIP-1193 user-rejected: the wallet prompt was dismissed. */
const USER_REJECTED_CODE = 4001;

function walletMessageFor(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  if (code === USER_REJECTED_CODE) {
    return 'The request was rejected in your wallet.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while talking to your wallet.';
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

  // --- Injected browser wallet (Phase 2) -----------------------------------
  // Read-only: connect, show the address/network, and read the BEES balance.
  // No transaction is ever constructed or broadcast here.
  const [walletDetected, setWalletDetected] = useState<boolean | null>(null);
  const [browserWallet, setBrowserWallet] = useState<{
    account: Address | null;
    chainId: number | null;
  } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [browserError, setBrowserError] = useState('');

  const [beesBalance, setBeesBalance] = useState<string | null>(null);
  const [beesLoading, setBeesLoading] = useState(false);
  const [beesError, setBeesError] = useState('');

  // --- BEES faucet (Phase 4) ----------------------------------------------
  // Claim 10 BEES once per wallet. Read-only until the user clicks; the actual
  // on-chain write (claim()) lives in lib/wallet/faucet.ts and is signed by the
  // user's own wallet. No private key is ever involved here.
  const [faucetClaimed, setFaucetClaimed] = useState<boolean | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimError, setClaimError] = useState('');

  // --- Server-side BEES claim (Phase 5) -----------------------------------
  // The PRIMARY onboarding path: a user pastes a public address, links it, and
  // the backend distributes 10 BEES to it (no browser-wallet signature needed
  // to RECEIVE). The backend signs claimFor() with its own faucet-owner key.
  const [serverClaimed, setServerClaimed] = useState<boolean | null>(null);
  const [serverClaiming, setServerClaiming] = useState(false);
  const [serverClaimTxHash, setServerClaimTxHash] = useState<string | null>(null);
  const [serverClaimError, setServerClaimError] = useState('');
  const [linkedBeesBalance, setLinkedBeesBalance] = useState<string | null>(null);
  const [linkedBeesLoading, setLinkedBeesLoading] = useState(false);
  const [linkedBeesError, setLinkedBeesError] = useState('');

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

  /**
   * Reflect the wallet's current state without prompting. `eth_accounts`
   * returns only already-authorised accounts, so this is safe on page load.
   */
  const syncBrowserWallet = useCallback(async () => {
    if (!isInjectedWalletAvailable()) {
      setWalletDetected(false);
      setBrowserWallet(null);
      return;
    }

    setWalletDetected(true);

    try {
      const [accounts, chainId] = await Promise.all([
        readAuthorizedAccounts(),
        getWalletChainId(),
      ]);
      setBrowserWallet({ account: accounts[0] ?? null, chainId });
    } catch (error) {
      setBrowserWallet(null);
      setBrowserError(walletMessageFor(error));
    }
  }, []);

  useEffect(() => {
    void syncBrowserWallet();
  }, [syncBrowserWallet]);

  // Keep the display honest if the user switches account or network in the
  // wallet after this page rendered.
  useEffect(() => {
    const provider = getInjectedProvider();
    if (!provider?.on) return undefined;

    const onChange = () => void syncBrowserWallet();

    provider.on('accountsChanged', onChange);
    provider.on('chainChanged', onChange);

    return () => {
      provider.removeListener?.('accountsChanged', onChange);
      provider.removeListener?.('chainChanged', onChange);
    };
  }, [syncBrowserWallet]);

  /** Read the BEES balance once there is an account on Base Sepolia. */
  useEffect(() => {
    const account = browserWallet?.account;
    const tokenAddress = status?.beesTokenAddress ?? null;

    if (!account || !tokenAddress || !isBaseSepolia(browserWallet?.chainId ?? null)) {
      setBeesBalance(null);
      setBeesError('');
      setBeesLoading(false);
      return undefined;
    }

    let cancelled = false;
    setBeesLoading(true);
    setBeesError('');

    readBeesBalance(tokenAddress, account)
      .then((baseUnits) => {
        if (!cancelled) setBeesBalance(formatBeesAmount(baseUnits));
      })
      .catch(() => {
        if (!cancelled) {
          setBeesBalance(null);
          setBeesError('Unable to read your BEES balance.');
        }
      })
      .finally(() => {
        if (!cancelled) setBeesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browserWallet, status?.beesTokenAddress]);

  /** Read whether this wallet has already claimed from the faucet. */
  useEffect(() => {
    const account = browserWallet?.account;
    const faucetAddress = status?.faucetAddress ?? null;

    if (!account || !faucetAddress || !isBaseSepolia(browserWallet?.chainId ?? null)) {
      setFaucetClaimed(null);
      setClaimError('');
      return undefined;
    }

    let cancelled = false;
    setFaucetClaimed(null);
    readFaucetClaimed(faucetAddress, account)
      .then((claimed) => {
        if (!cancelled) setFaucetClaimed(claimed);
      })
      .catch(() => {
        if (!cancelled) setFaucetClaimed(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browserWallet, status?.faucetAddress]);

  /**
   * Server-side claim status for the LINKED public address (no browser wallet
   * needed). Reads the on-chain hasClaimed flag so the UI can show the
   * already-claimed state before the user clicks.
   */
  useEffect(() => {
    const address = wallet?.address;
    const faucetAddress = status?.faucetAddress ?? null;

    if (!address || !faucetAddress) {
      setServerClaimed(null);
      setServerClaimError('');
      return undefined;
    }

    let cancelled = false;
    setServerClaimed(null);
    readFaucetClaimed(faucetAddress, address as Address)
      .then((claimed) => {
        if (!cancelled) setServerClaimed(claimed);
      })
      .catch(() => {
        if (!cancelled) setServerClaimed(false);
      });

    return () => {
      cancelled = true;
    };
  }, [wallet?.address, status?.faucetAddress]);

  /** Read the BEES balance of the linked public address (read-only, any address). */
  useEffect(() => {
    const address = wallet?.address;
    const tokenAddress = status?.beesTokenAddress ?? null;

    if (!address || !tokenAddress) {
      setLinkedBeesBalance(null);
      setLinkedBeesLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLinkedBeesLoading(true);
    setLinkedBeesError('');
    readBeesBalance(tokenAddress, address as Address)
      .then((baseUnits) => {
        if (!cancelled) setLinkedBeesBalance(formatBeesAmount(baseUnits));
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedBeesBalance(null);
          setLinkedBeesError('Unable to read your BEES balance.');
        }
      })
      .finally(() => {
        if (!cancelled) setLinkedBeesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [wallet?.address, status?.beesTokenAddress]);

  /** Prompt the wallet for access (`eth_requestAccounts`). */
  async function connectBrowserWallet() {
    setConnecting(true);
    setBrowserError('');

    try {
      const accounts = await requestWalletAccounts();
      if (accounts.length === 0) {
        setBrowserError('No account was selected in your wallet.');
      }
      await syncBrowserWallet();
    } catch (error) {
      setBrowserError(walletMessageFor(error));
    } finally {
      setConnecting(false);
    }
  }

  /**
   * Claim 10 BEES from the faucet. Simulates, requests the wallet signature,
   * waits for the receipt, then refreshes the BEES balance and records the tx.
   * All guards (connected, Base Sepolia, faucet configured) are re-checked here
   * so a stale render can never broadcast an unexpected transaction.
   */
  async function claimFromFaucet() {
    setClaiming(true);
    setClaimError('');
    setBanner(null);

    const account = browserWallet?.account;
    const faucetAddress = status?.faucetAddress ?? null;

    if (!account) {
      setClaimError('Connect your wallet to claim BEES.');
      setClaiming(false);
      return;
    }
    if (!isBaseSepolia(browserWallet?.chainId ?? null)) {
      setClaimError(`Switch your wallet to Base Sepolia (${DEFAULT_CHAIN_ID}) to claim BEES.`);
      setClaiming(false);
      return;
    }
    if (!faucetAddress) {
      setClaimError('The BEES faucet is not configured on the backend.');
      setClaiming(false);
      return;
    }

    try {
      const hash = await claimBees(faucetAddress, account);
      setClaimTxHash(hash);
      setFaucetClaimed(true);

      // Refresh the BEES balance so the UI reflects the newly claimed funds.
      const tokenAddress = status?.beesTokenAddress ?? null;
      if (tokenAddress) {
        try {
          const balance = await readBeesBalance(tokenAddress, account);
          setBeesBalance(formatBeesAmount(balance));
        } catch {
          // Balance refresh is best-effort; the claim itself already succeeded.
        }
      }

      setBanner({ kind: 'success', text: `Claimed ${FAUCET_CLAIM_LABEL} from the faucet.` });
    } catch (error) {
      const code = (error as { code?: number } | null)?.code;
      if (code === USER_REJECTED_CODE) {
        setClaimError('The claim was rejected in your wallet. Nothing was sent.');
      } else {
        const msg =
          (error as { shortMessage?: string } | null)?.shortMessage
          || (error instanceof Error ? error.message : '');
        if (/already claimed/i.test(msg)) {
          setFaucetClaimed(true);
          setClaimError('You have already claimed BEES from this faucet.');
        } else if (/faucet empty/i.test(msg)) {
          setClaimError('The faucet is out of BEES. Please let the demo admin know.');
        } else if (msg) {
          setClaimError(msg);
        } else {
          setClaimError('Something went wrong while claiming BEES. Please try again.');
        }
      }
    } finally {
      setClaiming(false);
    }
  }

  /**
   * Server-side claim: ask the backend to send 10 BEES to the linked public
   * address. No browser-wallet signature is required to receive the BEES — the
   * backend signs claimFor() with its own faucet-owner key. Re-checks the
   * linked address is present, then maps server responses to UI states
   * (pending / success+txHash / already-claimed / error).
   */
  async function claimBeesFromServer() {
    setServerClaiming(true);
    setServerClaimError('');
    setBanner(null);

    const address = wallet?.address;
    if (!address) {
      setServerClaimError('Link a public wallet address first.');
      setServerClaiming(false);
      return;
    }

    try {
      const result = await claimBeesServer(address);
      setServerClaimTxHash(result.txHash);
      setServerClaimed(true);

      // Refresh the linked address BEES balance so the UI reflects the funds.
      const tokenAddress = status?.beesTokenAddress ?? null;
      if (tokenAddress) {
        try {
          const balance = await readBeesBalance(tokenAddress, address as Address);
          setLinkedBeesBalance(formatBeesAmount(balance));
        } catch {
          // Best-effort; the claim already succeeded.
        }
      }

      setBanner({ kind: 'success', text: `Claimed ${FAUCET_CLAIM_LABEL} from the faucet.` });
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        setServerClaimed(true);
        setServerClaimError('This address has already claimed BEES from the faucet.');
      } else if (isApiError(error) && error.status === 403) {
        setServerClaimError('You can only claim for the wallet linked to your account.');
      } else {
        setServerClaimError(messageFor(error));
      }
    } finally {
      setServerClaiming(false);
    }
  }

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
          Link a public wallet on Base Sepolia. Committing to a challenge
          approves BEES and locks your stake on-chain.
        </p>
        {user && <p className="habits__user">Signed in as {user.name}</p>}
      </header>

      {banner && (
        <div className={banner.kind === 'success' ? 'alert alert--success' : 'alert alert--error'}>
          {banner.text}
        </div>
      )}

      <section className="card">
        <h2 className="card__title">Browser wallet</h2>

        {browserError && <div className="alert alert--error">{browserError}</div>}

        {walletDetected === null && (
          <p className="habits__muted">Checking for a browser wallet…</p>
        )}

        {walletDetected === false && (
          <p className="habits__muted">
            No browser wallet detected. Install MetaMask or another EIP-1193
            wallet extension, then reload this page to connect.
          </p>
        )}

        {walletDetected === true && !browserWallet?.account && (
          <>
            <p className="habits__muted">
              Connect your wallet to see your BEES balance on{' '}
              {chainName(DEFAULT_CHAIN_ID)} ({DEFAULT_CHAIN_ID}).
            </p>
            <div className="habits__form-actions">
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => void connectBrowserWallet()}
                disabled={connecting}
              >
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </button>
            </div>
          </>
        )}

        {browserWallet?.account && (
          <>
            <div className="wallet__detail">
              <p className="wallet__label">Connected address</p>
              <p className="wallet__address">{browserWallet.account}</p>

              <p className="wallet__label">Network</p>
              <p className="wallet__value">
                {browserWallet.chainId === null
                  ? 'Unknown'
                  : `${chainName(browserWallet.chainId)} (${browserWallet.chainId})`}
              </p>
            </div>

            {wallet
              && browserWallet.account.toLowerCase() !== wallet.address.toLowerCase() && (
                <p className="habits__muted">
                  This browser wallet is not the address linked to your Habitra
                  account.
                </p>
              )}

            {!isBaseSepolia(browserWallet.chainId) && (
              <div className="alert alert--error">
                Wrong network. Switch your wallet to {chainName(DEFAULT_CHAIN_ID)}{' '}
                ({DEFAULT_CHAIN_ID}) to use Habitra. Habitra will not switch
                networks for you.
              </div>
            )}

            {isBaseSepolia(browserWallet.chainId) && (
              <>
              <div className="wallet__detail">
                <p className="wallet__label">BEES balance</p>
                {!status?.beesTokenAddress ? (
                  <p className="habits__muted">
                    BEES token address is not configured on the backend.
                  </p>
                ) : beesLoading ? (
                  <p className="habits__muted">Loading BEES balance…</p>
                ) : beesError ? (
                  <p className="form__error-text">{beesError}</p>
                ) : (
                  <p className="wallet__value">{beesBalance ?? '0'} BEES</p>
                )}
              </div>

              {status?.faucetAddress ? (
                <div className="wallet__detail">
                  <p className="wallet__label">BEES faucet</p>
                  {faucetClaimed === null ? (
                    <p className="habits__muted">Checking claim status…</p>
                  ) : faucetClaimed ? (
                    <p className="wallet__value">
                      You have already claimed {FAUCET_CLAIM_LABEL}.
                    </p>
                  ) : (
                    <div className="habits__form-actions">
                      <button
                        className="btn btn--primary"
                        type="button"
                        onClick={() => void claimFromFaucet()}
                        disabled={claiming}
                      >
                        {claiming ? 'Claiming…' : `Claim ${FAUCET_CLAIM_LABEL}`}
                      </button>
                    </div>
                  )}
                  {claimTxHash && (
                    <p className="habits__muted">Claimed! Tx {shortHex(claimTxHash)}</p>
                  )}
                  {claimError && <div className="alert alert--error">{claimError}</div>}
                </div>
              ) : (
                <p className="habits__muted">BEES faucet is not configured.</p>
              )}
              </>
            )}
          </>
        )}
      </section>

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

            {/*
              PRIMARY BEES onboarding. The user pasted a public address above;
              the backend now distributes 10 BEES to it. No browser wallet and no
              user signature is required to RECEIVE BEES — signing is still
              required later when the user actually stakes (approve + lock).
            */}
            {status?.faucetAddress ? (
              <div className="wallet__detail">
                <p className="wallet__label">BEES balance</p>
                {!status?.beesTokenAddress ? (
                  <p className="habits__muted">
                    BEES token address is not configured on the backend.
                  </p>
                ) : linkedBeesLoading ? (
                  <p className="habits__muted">Loading BEES balance…</p>
                ) : linkedBeesError ? (
                  <p className="form__error-text">{linkedBeesError}</p>
                ) : (
                  <p className="wallet__value">{linkedBeesBalance ?? '0'} BEES</p>
                )}

                <p className="wallet__label">BEES faucet</p>
                {serverClaimed === null ? (
                  <p className="habits__muted">Checking claim status…</p>
                ) : serverClaimed ? (
                  <p className="wallet__value">
                    You have already claimed {FAUCET_CLAIM_LABEL}.
                  </p>
                ) : (
                  <div className="habits__form-actions">
                    <button
                      className="btn btn--primary"
                      type="button"
                      onClick={() => void claimBeesFromServer()}
                      disabled={serverClaiming}
                    >
                      {serverClaiming ? 'Sending BEES…' : `Claim ${FAUCET_CLAIM_LABEL}`}
                    </button>
                  </div>
                )}

                {serverClaimTxHash && (
                  <p className="habits__muted">Claimed! Tx {shortHex(serverClaimTxHash)}</p>
                )}
                {serverClaimError && <div className="alert alert--error">{serverClaimError}</div>}
              </div>
            ) : (
              <p className="habits__muted">BEES faucet is not configured.</p>
            )}

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
          Not listed here yet — the backend does not expose a
          transaction-history endpoint, so nothing is fetched or invented.
          Staking approves BEES and locks the stake in the escrow contract on
          Base Sepolia; the lock is verified on-chain before the stake is
          confirmed. Stake status is shown with each challenge.
        </p>
      </section>
    </main>
  );
}

/**
 * injectedWallet.ts — Phase 1 foundation for talking to an injected EIP-1193
 * wallet (MetaMask, Rabby, Brave, …) through `window.ethereum`.
 *
 * SCOPE OF THIS FILE
 * ------------------
 * Detection, account/chain reads and viem client construction ONLY. It performs
 * no contract call, no balance read, no approval, no transaction of any kind,
 * and it is imported by no page yet — adding it changes no existing behaviour.
 *
 * SECURITY BOUNDARY (do not break this)
 * -------------------------------------
 * The backend must never receive a private key, seed phrase or signature
 * secret. Nothing here can produce one: `custom(window.ethereum)` asks the
 * wallet extension to sign, and viem only ever receives the resulting
 * signature / transaction hash back. No account is constructed from a key, so
 * this module has no way to hold key material.
 *
 * The existing contract ABIs (lib/contracts/abi.ts) are deliberately NOT
 * imported yet — no contract is called in Phase 1. They are unchanged and are
 * the intended input for the next phase.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import type { InjectedWalletProvider } from '../../types/eip1193';

/** Base Sepolia — the only chain Habitra targets (PRD §19). */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** The same chain id as a hex quantity, for `wallet_switchEthereumChain`. */
export const BASE_SEPOLIA_CHAIN_ID_HEX = '0x14a34';

/**
 * The injected provider, or null when there is no wallet / no browser.
 *
 * Null (not a throw) is deliberate: pages need to render an "install a wallet"
 * state rather than crash.
 */
export function getInjectedProvider(): InjectedWalletProvider | null {
  if (typeof window === 'undefined') return null;
  return window.ethereum ?? null;
}

/** True when a browser wallet is available to connect. */
export function isInjectedWalletAvailable(): boolean {
  return getInjectedProvider() !== null;
}

/**
 * Read the accounts the wallet has ALREADY authorised for this site
 * (`eth_accounts`) — no prompt, so it is safe to call on page load to restore
 * a previous connection. Empty array when nothing is authorised yet.
 */
export async function readAuthorizedAccounts(): Promise<Address[]> {
  const provider = getInjectedProvider();
  if (!provider) return [];

  const accounts = await provider.request({ method: 'eth_accounts' });

  if (!Array.isArray(accounts)) return [];

  return accounts.filter((account): account is Address => typeof account === 'string');
}

/**
 * Ask the wallet for the accounts the user has authorised (`eth_requestAccounts`).
 *
 * This is the connection step: it prompts the wallet and resolves only with
 * accounts the user chose to expose. Returns an empty array when the user
 * approves the prompt but selects no account; throws when the user rejects it
 * or no wallet is installed.
 */
export async function requestWalletAccounts(): Promise<Address[]> {
  const provider = getInjectedProvider();
  if (!provider) {
    throw new Error('No Ethereum wallet detected. Install a browser wallet to continue.');
  }

  const accounts = await provider.request({ method: 'eth_requestAccounts' });

  if (!Array.isArray(accounts)) return [];

  return accounts.filter((account): account is Address => typeof account === 'string');
}

/**
 * Read the wallet's currently selected chain id (`eth_chainId`) as a number.
 * Returns null when there is no wallet or the response is not a hex quantity.
 */
export async function getWalletChainId(): Promise<number | null> {
  const provider = getInjectedProvider();
  if (!provider) return null;

  const raw = await provider.request({ method: 'eth_chainId' });
  if (typeof raw !== 'string') return null;

  const parsed = Number.parseInt(raw, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the wallet is on Base Sepolia (84532). */
export function isBaseSepolia(chainId: number | null): boolean {
  return chainId === BASE_SEPOLIA_CHAIN_ID;
}

/**
 * Read-only viem client bound to Base Sepolia, using the wallet as the RPC
 * transport — so no RPC URL needs to be configured or shipped to the browser.
 *
 * The return type is inferred rather than spelled out: viem's `PublicClient`
 * is generic over the chain, and the concrete `typeof baseSepolia` block type
 * is narrower than the default `Chain | undefined`, so an explicit
 * `PublicClient` annotation does not typecheck.
 */
export function createBrowserPublicClient() {
  const provider = getInjectedProvider();
  if (!provider) return null;

  return createPublicClient({
    chain: baseSepolia,
    transport: custom(provider),
  });
}

/**
 * Signing viem client bound to Base Sepolia and to `account`.
 *
 * `account` must be an address the wallet exposed via `eth_requestAccounts`;
 * viem sends the request to the wallet, which signs with its own key. Passing
 * `chain: baseSepolia` makes viem refuse to send on any other network. As
 * above, the return type is inferred for the same generic-variance reason.
 */
export function createBrowserWalletClient(account: Address) {
  const provider = getInjectedProvider();
  if (!provider) return null;

  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: custom(provider),
  });
}

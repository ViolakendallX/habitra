/**
 * Global typing for an injected EIP-1193 wallet (`window.ethereum`).
 *
 * The base type comes from viem, so the provider handed to `custom(provider)`
 * in lib/wallet/injectedWallet.ts is accepted without a cast. `on` /
 * `removeListener` are added here because they are part of the EIP-1193 event
 * API but not of viem's request-only type.
 *
 * Only the *presence* of these members is declared — nothing is added at
 * runtime and no wallet is touched at import time. `ethereum` is optional
 * because a browser without a wallet extension never defines it.
 */

import type { EIP1193Provider } from 'viem';

export interface InjectedWalletProvider extends EIP1193Provider {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: InjectedWalletProvider;
  }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title HabitraBeesFaucet
 * @notice Base Sepolia testnet faucet for the EXISTING Habitra BEES ERC-20.
 *
 * WHAT IT DOES
 * ------------
 * Distributes BEES held by this contract to each unique address exactly once
 * (10 BEES per claim, 18 decimals — see claimAmount).
 *
 * Two claim paths, both guarded by the same `hasClaimed` mapping so an address
 * can never be funded twice (regardless of checksum case — the guard keys on
 * the address bytes, not the hex string):
 *   - `claim()`         — initiated by the user's own connected wallet
 *     (`msg.sender`); the user signs and the faucet transfers to them.
 *   - `claimFor(addr)`  — initiated server-side by the owner (onlyOwner); the
 *     backend distributes already-funded BEES to `addr` on behalf of a user who
 *     only pasted a public address (no wallet signature required to RECEIVE).
 * The faucet never holds or signs with a user's key.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * - It does NOT mint. Minting BEES is the BEES owner's privilege and happens
 *   off-faucet (the owner mints BEES to this contract's address to fund it).
 *   The faucet only transfers BEES it already holds.
 * - It does NOT modify the BEES token or the escrow contract.
 * - No private keys, seed phrases or secrets appear anywhere in this source.
 *
 * SECURITY NOTES
 * --------------
 * - Solidity 0.8.x: arithmetic is checked (overflow/underflow reverts).
 * - Each address may claim once (hasClaimed guard); a second claim reverts
 *   with AlreadyClaimed. A claim reverts with FaucetEmpty when the faucet is
 *   out of BEES, so it can never transfer more than it holds.
 * - The owner can withdraw() any remaining BEES (e.g. after the demo) — there
 *   is no arbitrary sweep of user funds because the faucet only ever holds the
 *   owner-funded supply, never user stakes.
 */
contract HabitraBeesFaucet is Ownable {
    using SafeERC20 for IERC20;

    /// @notice The existing BEES ERC-20 this faucet distributes. Immutable.
    IERC20 public immutable bees;

    /// @notice BEES (base units, 18 decimals) sent per successful claim. Immutable.
    uint256 public immutable claimAmount;

    /// @notice Whether an address has already claimed.
    mapping(address => bool) public hasClaimed;

    /// @notice Total BEES distributed so far (for diagnostics).
    uint256 public totalClaimed;

    /// @notice Emitted on every successful claim.
    event Claimed(address indexed claimer, uint256 amount);

    error AlreadyClaimed();
    error FaucetEmpty();
    error ZeroAddress();

    /**
     * @param beesToken      Existing BEES ERC-20 address (must not be zero).
     * @param initialOwner   Address allowed to withdraw remaining BEES.
     * @param amount         BEES (base units) distributed per claim.
     */
    constructor(address beesToken, address initialOwner, uint256 amount) Ownable(initialOwner) {
        if (beesToken == address(0)) revert ZeroAddress();
        bees = IERC20(beesToken);
        claimAmount = amount;
    }

    /**
     * @notice Claim `claimAmount` BEES once per address.
     * @dev Reverts with AlreadyClaimed if the sender already claimed, or
     *      FaucetEmpty if the faucet has insufficient BEES. The transfer uses
     *      SafeERC20 so a non-compliant token cannot silently fail.
     */
    function claim() external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        uint256 amount = claimAmount;
        if (bees.balanceOf(address(this)) < amount) revert FaucetEmpty();

        hasClaimed[msg.sender] = true;
        totalClaimed += amount;

        emit Claimed(msg.sender, amount);
        bees.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Owner-distributed claim: send `claimAmount` BEES to `recipient`
     *         exactly once, on behalf of a user who supplied only a public
     *         address (server-side onboarding — no wallet signature needed to
     *         RECEIVE BEES).
     * @dev onlyOwner. Uses the same `hasClaimed[recipient]` guard as `claim()`,
     *      so an address can never be funded twice through either path. Reverts
     *      with AlreadyClaimed if `recipient` already claimed, ZeroAddress if
     *      `recipient` is the zero address, or FaucetEmpty if out of BEES. The
     *      transfer uses SafeERC20 so a non-compliant token cannot silently fail.
     * @param recipient Public EVM address that will RECEIVE the BEES.
     */
    function claimFor(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (hasClaimed[recipient]) revert AlreadyClaimed();

        uint256 amount = claimAmount;
        if (bees.balanceOf(address(this)) < amount) revert FaucetEmpty();

        hasClaimed[recipient] = true;
        totalClaimed += amount;

        emit Claimed(recipient, amount);
        bees.safeTransfer(recipient, amount);
    }

    /**
     * @notice Owner can withdraw any remaining BEES (e.g. after the demo).
     * @dev Only the owner may call this (onlyOwner). It moves only the faucet's
     *      own idle balance; it cannot touch BEES held elsewhere.
     */
    function withdraw() external onlyOwner {
        uint256 balance = bees.balanceOf(address(this));
        if (balance > 0) bees.safeTransfer(owner(), balance);
    }
}

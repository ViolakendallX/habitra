// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BEES — "Habitra BEES"
 * @notice Test/demo ERC-20 used by Habitra to represent habit-consistency
 *         rewards and challenge stakes.
 *
 * WHAT BEES IS
 * ------------
 * BEES is a *demo token for Base Sepolia only*. It has no monetary value, no
 * market, no bridge and no mainnet deployment. It exists so the Habitra
 * accountability loop (keep a habit -> earn; break a commitment -> lose) can be
 * exercised end-to-end on a real EVM chain with real ERC-20 semantics, without
 * touching anything of value.
 *
 * MINTING
 * -------
 * Minting is restricted to the contract owner (the Habitra deployer/admin EOA).
 * There is no public mint, no faucet function and no minter role beyond owner,
 * so an arbitrary address cannot inflate the supply. The owner is expected to be
 * a Base Sepolia test EOA; a production system would move minting behind a
 * multisig or remove it entirely.
 *
 * SECURITY NOTES
 * --------------
 * - Solidity 0.8.x: arithmetic is checked, so overflow/underflow reverts.
 * - No private keys, seed phrases or secrets appear anywhere in this source.
 * - Constructor rejects the zero address as owner so supply can never be
 *   permanently un-mintable by accident.
 */
contract BEES is ERC20, Ownable {
    /// @notice Emitted whenever new demo BEES are created.
    event BeesMinted(address indexed to, uint256 amount, address indexed minter);

    /**
     * @param initialOwner Address allowed to mint (Habitra admin/deployer EOA).
     */
    constructor(address initialOwner) ERC20("Habitra BEES", "BEES") Ownable(initialOwner) {
        require(initialOwner != address(0), "BEES: owner is zero address");
    }

    /// @notice BEES uses 18 decimals, same as ETH and most ERC-20s.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /**
     * @notice Mint demo BEES. Owner-only.
     * @param to      Recipient; must not be the zero address.
     * @param amount  Amount in base units (1 BEES = 1e18). Must be non-zero.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "BEES: mint to zero address");
        require(amount > 0, "BEES: mint amount is zero");

        _mint(to, amount);
        emit BeesMinted(to, amount, msg.sender);
    }
}

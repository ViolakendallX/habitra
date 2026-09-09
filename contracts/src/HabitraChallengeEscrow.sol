// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HabitraChallengeEscrow
 * @notice Minimal, hackathon-scope escrow that turns a Habitra challenge into an
 *         on-chain economic commitment denominated in BEES.
 *
 * HOW A HABITRA CHALLENGE MAPS ON-CHAIN
 * -------------------------------------
 *   1. Off-chain, the user creates a Challenge (title, dates, maxMisses, one
 *      linked habit) and chooses a BEES stake.
 *   2. The user approves this contract to spend that stake (`BEES.approve`).
 *   3. The user calls `lock(challengeId, amount, endsAt)`. BEES move from the
 *      user into this contract and a `Commitment` is recorded. Nothing else can
 *      happen to that stake until it is settled.
 *   4. Off-chain, the existing Habitra evaluator (`services/challenges.ts`)
 *      computes COMPLETED / FAILED from habit completion data.
 *   5. The Habitra resolver calls `settle(commitmentId, succeeded)`:
 *        - succeeded == true  -> the full stake is returned to the user.
 *        - succeeded == false -> the full stake is transferred to `treasury`.
 *   6. Settlement is one-shot: `settled` is set before the transfer, so a
 *      commitment can never be paid out twice.
 *
 * TRUST BOUNDARY (read this before extending the contract)
 * --------------------------------------------------------
 * - OFF-CHAIN: the *decision*. Whether a challenge passed or failed is decided
 *   by Habitra's off-chain evaluator from habit-completion data. The chain has
 *   no access to that data and cannot verify it.
 * - ON-CHAIN: the *economic consequence*. This contract enforces who gets the
 *   locked BEES, that it happens exactly once, and that only the resolver can
 *   trigger it. It does NOT and cannot judge habit performance.
 * - `resolver` is therefore a trusted role. A compromised resolver can settle a
 *   live commitment early. This is a deliberate, documented limitation of the
 *   demo layer (the alternative — an oracle — is out of scope for this stage).
 *   Mitigations: a single Habitra-controlled EOA, every settlement emits an
 *   event, and every settlement is mirrored off-chain in the `Transaction`
 *   table, so misuse is visible and auditable.
 * - The admin (owner) CANNOT arbitrarily withdraw user funds: there is no
 *   withdraw / sweep / rescue function on this contract. The owner can only
 *   change `treasury` and `resolver`, and those changes only affect future
 *   settlements — never funds that are already locked.
 *
 * OUT OF SCOPE (deliberately not implemented): staking, yield, NFTs, DeFi,
 * governance, partial slashing, multi-token support, mainnet deployment.
 *
 * SECURITY NOTES
 * --------------
 * - Solidity 0.8.x checked arithmetic; no unchecked blocks.
 * - SafeERC20 for every token movement (handles non-standard return values).
 * - Checks-Effects-Interactions + ReentrancyGuard.
 * - No private keys, seed phrases or secrets appear anywhere in this source.
 */
contract HabitraChallengeEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A single locked challenge stake.
    struct Commitment {
        /// @notice Address that locked the stake and receives it back on success.
        address user;
        /// @notice Locked amount in BEES base units.
        uint256 amount;
        /// @notice Unix timestamp (seconds) at which the challenge ends off-chain.
        uint64 endsAt;
        /// @notice True once `settle` has run. Guards against double settlement.
        bool settled;
        /// @notice Outcome recorded at settlement: true = passed, false = failed.
        bool succeeded;
        /// @notice Habitra off-chain challenge id (cuid). Mirrored for traceability.
        string challengeId;
    }

    /// @notice BEES token accepted by this escrow.
    IERC20 public immutable bees;

    /// @notice Address that receives slashed stakes. Set at deployment, changeable by owner.
    address public treasury;

    /// @notice Address allowed to settle commitments (the Habitra backend resolver).
    address public resolver;

    /// @notice Next commitment id. Starts at 1 so 0 can mean "unset".
    uint256 public nextCommitmentId = 1;

    /// @notice Maximum accepted length of an off-chain challenge id (gas guard).
    uint256 public constant MAX_CHALLENGE_ID_LENGTH = 64;

    mapping(uint256 => Commitment) private _commitments;

    /// @notice Off-chain challenge id -> commitment id (0 when not locked).
    mapping(string => uint256) public commitmentIdByChallenge;

    event ChallengeLocked(
        uint256 indexed commitmentId,
        string challengeId,
        address indexed user,
        uint256 amount,
        uint64 endsAt
    );

    event ChallengeCompleted(
        uint256 indexed commitmentId, string challengeId, address indexed user, uint256 amount
    );

    event ChallengeFailed(
        uint256 indexed commitmentId,
        string challengeId,
        address indexed user,
        uint256 amount,
        address indexed treasury
    );

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ResolverUpdated(address indexed previousResolver, address indexed newResolver);

    /**
     * @param beesToken     BEES ERC-20 address.
     * @param treasury_     Recipient of slashed stakes.
     * @param initialOwner  Admin; also becomes the initial resolver.
     */
    constructor(address beesToken, address treasury_, address initialOwner) Ownable(initialOwner) {
        require(beesToken != address(0), "escrow: token is zero address");
        require(treasury_ != address(0), "escrow: treasury is zero address");
        require(initialOwner != address(0), "escrow: owner is zero address");

        bees = IERC20(beesToken);
        treasury = treasury_;
        resolver = initialOwner;

        emit TreasuryUpdated(address(0), treasury_);
        emit ResolverUpdated(address(0), initialOwner);
    }

    // ---------------------------------------------------------------------
    // Admin (does NOT grant access to locked user funds)
    // ---------------------------------------------------------------------

    /// @notice Update the slashed-funds recipient. Only affects future settlements.
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "escrow: treasury is zero address");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Update the settlement resolver. Only affects future settlements.
    function setResolver(address newResolver) external onlyOwner {
        require(newResolver != address(0), "escrow: resolver is zero address");
        emit ResolverUpdated(resolver, newResolver);
        resolver = newResolver;
    }

    // ---------------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------------

    /**
     * @notice Lock a BEES stake against an off-chain Habitra challenge.
     * @dev Requires a prior `BEES.approve(escrow, amount)` by the caller.
     * @param challengeId Off-chain Habitra challenge id (non-empty, <= 64 bytes).
     * @param amount      Stake in BEES base units; must be > 0.
     * @param endsAt      Challenge end timestamp; must be in the future.
     * @return commitmentId Id of the newly created commitment.
     */
    function lock(string calldata challengeId, uint256 amount, uint64 endsAt)
        external
        nonReentrant
        returns (uint256 commitmentId)
    {
        require(bytes(challengeId).length > 0, "escrow: challenge id is empty");
        require(bytes(challengeId).length <= MAX_CHALLENGE_ID_LENGTH, "escrow: challenge id too long");
        require(amount > 0, "escrow: stake is zero");
        require(endsAt > block.timestamp, "escrow: end time is not in the future");
        require(commitmentIdByChallenge[challengeId] == 0, "escrow: challenge already locked");

        commitmentId = nextCommitmentId;
        nextCommitmentId = commitmentId + 1;
        commitmentIdByChallenge[challengeId] = commitmentId;

        _commitments[commitmentId] = Commitment({
            user: msg.sender,
            amount: amount,
            endsAt: endsAt,
            settled: false,
            succeeded: false,
            challengeId: challengeId
        });

        // Effects are written before this external call; SafeERC20 handles
        // non-standard ERC-20 return values.
        bees.safeTransferFrom(msg.sender, address(this), amount);

        emit ChallengeLocked(commitmentId, challengeId, msg.sender, amount, endsAt);
    }

    // ---------------------------------------------------------------------
    // Resolver action
    // ---------------------------------------------------------------------

    /**
     * @notice Settle a locked commitment. Resolver-only, one-shot.
     * @param commitmentId Id returned by `lock`.
     * @param succeeded    Off-chain verdict: true = user passed, false = user failed.
     */
    function settle(uint256 commitmentId, bool succeeded) external nonReentrant {
        require(msg.sender == resolver, "escrow: caller is not the resolver");

        Commitment storage commitment = _commitments[commitmentId];
        require(commitment.user != address(0), "escrow: unknown commitment");
        require(!commitment.settled, "escrow: already settled");

        address user = commitment.user;
        uint256 amount = commitment.amount;
        string memory challengeId = commitment.challengeId;
        address recipient = succeeded ? user : treasury;

        // Effects before interactions: this is what makes double settlement
        // impossible even if the token re-enters.
        commitment.settled = true;
        commitment.succeeded = succeeded;

        if (succeeded) {
            emit ChallengeCompleted(commitmentId, challengeId, user, amount);
        } else {
            emit ChallengeFailed(commitmentId, challengeId, user, amount, treasury);
        }

        bees.safeTransfer(recipient, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Full commitment record. Zero-address `user` means "does not exist".
    function getCommitment(uint256 commitmentId) external view returns (Commitment memory) {
        return _commitments[commitmentId];
    }

    /// @notice True when a commitment exists and has not been settled yet.
    function isPending(uint256 commitmentId) external view returns (bool) {
        Commitment storage commitment = _commitments[commitmentId];
        return commitment.user != address(0) && !commitment.settled;
    }
}

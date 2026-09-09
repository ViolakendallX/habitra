/**
 * Contract tests for the minimal Habitra Base + BEES on-chain layer.
 *
 * Run with: npm test  (inside contracts/)
 *
 * Tooling: Hardhat in-process network + viem (no ethers, no extra runtime deps).
 * Everything runs locally on the Hardhat network — no RPC, no Base Sepolia
 * connection and no deployment of any kind.
 */

const assert = require('node:assert/strict');
const hre = require('hardhat');
const {
  createWalletClient,
  createPublicClient,
  custom,
  getContract,
  parseUnits,
} = require('viem');
const { hardhat } = require('viem/chains');

const STAKE = parseUnits('25', 18);
const CHALLENGE_ID = 'cm9h4b1xg0001hbt';
const ONE_HOUR = 3600n;

let publicClient;
let walletClient;
let owner;
let treasury;
let resolver;
let user;
let stranger;
let bees;
let escrow;
let beesAddress;
let escrowAddress;

async function deployArtifact(name, args) {
  const { abi, bytecode } = await hre.artifacts.readArtifact(name);
  const hash = await walletClient.deployContract({ abi, bytecode, args, account: owner });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress, `${name} deployment produced no address`);
  return { address: receipt.contractAddress, abi };
}

/** Flattens a viem error into searchable text (shortMessage, causes, meta). */
function errorText(error, depth = 0) {
  if (!error || depth > 5) return '';
  const parts = [
    error.shortMessage,
    error.message,
    ...(Array.isArray(error.metaMessages) ? error.metaMessages : []),
  ].filter(Boolean);
  return `${parts.join(' | ')} ${errorText(error.cause, depth + 1)}`;
}

async function expectRevert(promise, expected) {
  try {
    await promise;
  } catch (error) {
    const text = errorText(error);
    const ok = expected instanceof RegExp ? expected.test(text) : text.includes(expected);
    assert.ok(
      ok,
      `Expected revert matching ${expected}, got:\n${text || '(empty error message)'}`,
    );
    return;
  }
  assert.fail(`Expected revert matching ${expected}, but the call succeeded`);
}

async function futureEndsAt() {
  const block = await publicClient.getBlock();
  return BigInt(block.timestamp) + ONE_HOUR;
}

async function setup() {
  const provider = hre.network.provider;
  publicClient = createPublicClient({ chain: hardhat, transport: custom(provider) });
  walletClient = createWalletClient({ chain: hardhat, transport: custom(provider) });

  [owner, treasury, resolver, user, stranger] = await walletClient.getAddresses();

  const beesDeployed = await deployArtifact('BEES', [owner]);
  beesAddress = beesDeployed.address;
  bees = getContract({
    address: beesAddress,
    abi: beesDeployed.abi,
    client: { public: publicClient, wallet: walletClient },
  });

  const escrowDeployed = await deployArtifact('HabitraChallengeEscrow', [
    beesAddress,
    treasury,
    owner,
  ]);
  escrowAddress = escrowDeployed.address;
  escrow = getContract({
    address: escrowAddress,
    abi: escrowDeployed.abi,
    client: { public: publicClient, wallet: walletClient },
  });

  await escrow.write.setResolver([resolver], { account: owner });
}

async function fundUser(amount = STAKE) {
  await bees.write.mint([user, amount], { account: owner });
}

async function approveEscrow(amount = STAKE) {
  await bees.write.approve([escrowAddress, amount], { account: user });
}

describe('BEES (Habitra BEES demo ERC-20)', () => {
  beforeEach(setup);

  it('has the expected name, symbol and decimals', async () => {
    assert.equal(await bees.read.name(), 'Habitra BEES');
    assert.equal(await bees.read.symbol(), 'BEES');
    assert.equal(await bees.read.decimals(), 18);
  });

  it('lets the owner mint and rejects minting by anyone else', async () => {
    // Owner can mint.
    await bees.write.mint([user, STAKE], { account: owner });
    assert.equal(await bees.read.balanceOf([user]), STAKE);

    // Non-owner cannot mint.
    const before = await bees.read.totalSupply();
    await expectRevert(
      bees.write.mint([stranger, STAKE], { account: stranger }),
      /revert/i,
    );
    assert.equal(await bees.read.totalSupply(), before);
    assert.equal(await bees.read.balanceOf([stranger]), 0n);
  });

  it('rejects minting to the zero address and zero-amount mints', async () => {
    await expectRevert(
      bees.write.mint(['0x0000000000000000000000000000000000000000', STAKE], { account: owner }),
      'BEES: mint to zero address',
    );
    await expectRevert(
      bees.write.mint([user, 0n], { account: owner }),
      'BEES: mint amount is zero',
    );
  });
});

describe('HabitraChallengeEscrow', () => {
  beforeEach(setup);

  it('rejects a lock when the escrow has no BEES allowance', async () => {
    await fundUser();
    // Deliberately no approve().
    await expectRevert(
      escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user }),
      /revert/i,
    );
    assert.equal(await bees.read.balanceOf([escrowAddress]), 0n);
    assert.equal(await bees.read.balanceOf([user]), STAKE);
  });

  it('locks the stake after approval and records the commitment details', async () => {
    await fundUser();
    await approveEscrow();

    const endsAt = await futureEndsAt();
    await escrow.write.lock([CHALLENGE_ID, STAKE, endsAt], { account: user });

    // Funds moved.
    assert.equal(await bees.read.balanceOf([user]), 0n);
    assert.equal(await bees.read.balanceOf([escrowAddress]), STAKE);

    // Details recorded.
    const commitment = await escrow.read.getCommitment([1n]);
    assert.equal(commitment.user.toLowerCase(), user.toLowerCase());
    assert.equal(commitment.amount, STAKE);
    assert.equal(commitment.endsAt, endsAt);
    assert.equal(commitment.settled, false);
    assert.equal(commitment.succeeded, false);
    assert.equal(commitment.challengeId, CHALLENGE_ID);

    // Off-chain id -> on-chain id mapping, and pending state.
    assert.equal(await escrow.read.commitmentIdByChallenge([CHALLENGE_ID]), 1n);
    assert.equal(await escrow.read.isPending([1n]), true);
  });

  it('rejects a zero stake', async () => {
    await fundUser();
    await approveEscrow();
    await expectRevert(
      escrow.write.lock([CHALLENGE_ID, 0n, await futureEndsAt()], { account: user }),
      'escrow: stake is zero',
    );
    assert.equal(await bees.read.balanceOf([escrowAddress]), 0n);
  });

  it('rejects an empty challenge id and an over-long challenge id', async () => {
    await fundUser();
    await approveEscrow();

    await expectRevert(
      escrow.write.lock(['', STAKE, await futureEndsAt()], { account: user }),
      'escrow: challenge id is empty',
    );

    await expectRevert(
      escrow.write.lock(['x'.repeat(65), STAKE, await futureEndsAt()], { account: user }),
      'escrow: challenge id too long',
    );
  });

  it('rejects an end time that is not in the future', async () => {
    await fundUser();
    await approveEscrow();

    const now = BigInt((await publicClient.getBlock()).timestamp);
    await expectRevert(
      escrow.write.lock([CHALLENGE_ID, STAKE, now - 1n], { account: user }),
      'escrow: end time is not in the future',
    );
    await expectRevert(
      escrow.write.lock([CHALLENGE_ID, STAKE, now], { account: user }),
      'escrow: end time is not in the future',
    );
  });

  it('rejects locking the same off-chain challenge twice', async () => {
    await fundUser(STAKE * 2n);
    await approveEscrow(STAKE * 2n);

    await escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user });
    await expectRevert(
      escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user }),
      'escrow: challenge already locked',
    );
  });

  it('returns the full stake to the user when the challenge succeeds', async () => {
    await fundUser();
    await approveEscrow();
    await escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user });

    const treasuryBefore = await bees.read.balanceOf([treasury]);
    await escrow.write.settle([1n, true], { account: resolver });

    assert.equal(await bees.read.balanceOf([user]), STAKE);
    assert.equal(await bees.read.balanceOf([escrowAddress]), 0n);
    assert.equal(await bees.read.balanceOf([treasury]), treasuryBefore);

    const commitment = await escrow.read.getCommitment([1n]);
    assert.equal(commitment.settled, true);
    assert.equal(commitment.succeeded, true);
    assert.equal(await escrow.read.isPending([1n]), false);
  });

  it('slashes the full stake to the treasury when the challenge fails', async () => {
    await fundUser();
    await approveEscrow();
    await escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user });

    const treasuryBefore = await bees.read.balanceOf([treasury]);
    await escrow.write.settle([1n, false], { account: resolver });

    assert.equal(await bees.read.balanceOf([user]), 0n);
    assert.equal(await bees.read.balanceOf([escrowAddress]), 0n);
    assert.equal(await bees.read.balanceOf([treasury]), treasuryBefore + STAKE);

    const commitment = await escrow.read.getCommitment([1n]);
    assert.equal(commitment.settled, true);
    assert.equal(commitment.succeeded, false);
  });

  it('prevents double settlement of the same commitment', async () => {
    await fundUser();
    await approveEscrow();
    await escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user });

    await escrow.write.settle([1n, true], { account: resolver });
    const userAfterSuccess = await bees.read.balanceOf([user]);
    assert.equal(userAfterSuccess, STAKE);

    // Second settlement — even with the opposite verdict — must revert and must
    // not move any additional funds.
    await expectRevert(
      escrow.write.settle([1n, false], { account: resolver }),
      'escrow: already settled',
    );

    assert.equal(await bees.read.balanceOf([user]), userAfterSuccess);
    assert.equal(await bees.read.balanceOf([treasury]), 0n);
    assert.equal(await bees.read.balanceOf([escrowAddress]), 0n);
  });

  it('rejects settlement by anyone who is not the resolver', async () => {
    await fundUser();
    await approveEscrow();
    await escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user });

    // A random address, and even the contract owner (owner != resolver here),
    // must not be able to settle.
    await expectRevert(
      escrow.write.settle([1n, false], { account: stranger }),
      'escrow: caller is not the resolver',
    );
    await expectRevert(
      escrow.write.settle([1n, true], { account: owner }),
      'escrow: caller is not the resolver',
    );

    assert.equal(await bees.read.balanceOf([escrowAddress]), STAKE);
    assert.equal(await escrow.read.isPending([1n]), true);
  });

  it('rejects settlement of an unknown commitment id', async () => {
    await expectRevert(
      escrow.write.settle([999n, true], { account: resolver }),
      'escrow: unknown commitment',
    );
    await expectRevert(
      escrow.write.settle([0n, true], { account: resolver }),
      'escrow: unknown commitment',
    );
  });

  it('exposes no arbitrary-withdrawal function (admin cannot drain user stakes)', async () => {
    const writeNames = escrow.abi
      .filter((item) => item.type === 'function' && item.stateMutability !== 'view')
      .map((item) => item.name);

    assert.deepEqual(
      [...writeNames].sort(),
      [
        'lock',
        'renounceOwnership',
        'setResolver',
        'setTreasury',
        'settle',
        'transferOwnership',
      ].sort(),
      `unexpected state-changing functions: ${writeNames.join(', ')}`,
    );

    // Belt and braces: no withdraw/sweep/rescue-style entry point exists at all.
    for (const name of writeNames) {
      assert.ok(
        !/withdraw|sweep|rescue|drain|skim|transfer\(|transferFrom/.test(name),
        `contract exposes a fund-moving function: ${name}`,
      );
    }
  });

  it('only lets the owner change treasury and resolver, and only affects future settlements', async () => {
    await fundUser();
    await approveEscrow();
    await escrow.write.lock([CHALLENGE_ID, STAKE, await futureEndsAt()], { account: user });

    // Non-owner cannot change either role.
    await expectRevert(
      escrow.write.setTreasury([stranger], { account: stranger }),
      /revert/i,
    );
    await expectRevert(
      escrow.write.setResolver([stranger], { account: stranger }),
      /revert/i,
    );

    // Owner can, but the already-locked stake is untouched.
    await escrow.write.setTreasury([stranger], { account: owner });
    assert.equal((await escrow.read.treasury()).toLowerCase(), stranger.toLowerCase());
    assert.equal(await bees.read.balanceOf([escrowAddress]), STAKE);
    assert.equal(await bees.read.balanceOf([stranger]), 0n);

    // Zero address is rejected for both roles.
    await expectRevert(
      escrow.write.setTreasury(['0x0000000000000000000000000000000000000000'], { account: owner }),
      'escrow: treasury is zero address',
    );
    await expectRevert(
      escrow.write.setResolver(['0x0000000000000000000000000000000000000000'], { account: owner }),
      'escrow: resolver is zero address',
    );
  });
});

/**
 * Contract tests for the Habitra BEES faucet (HabitraBeesFaucet).
 *
 * Run with: npm test  (inside contracts/)
 *
 * Tooling: Hardhat in-process network + viem (no ethers, no extra runtime deps).
 * Everything runs locally on the Hardhat network — no RPC, no Base Sepolia
 * connection and no deployment of any kind. BEES is freshly deployed here and
 * funded by minting to the faucet (the owner-only path the real deploy uses).
 */

const assert = require('node:assert/strict');
const hre = require('hardhat');
const { createWalletClient, createPublicClient, custom, getContract, parseUnits } = require('viem');
const { hardhat } = require('viem/chains');

const CLAIM = parseUnits('10', 18);
const FUND = parseUnits('100', 18);

let publicClient;
let walletClient;
let owner;
let user;
let stranger;
let bees;
let faucet;
let beesAddress;
let faucetAddress;

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

async function setup() {
  const provider = hre.network.provider;
  publicClient = createPublicClient({ chain: hardhat, transport: custom(provider) });
  walletClient = createWalletClient({ chain: hardhat, transport: custom(provider) });

  [owner, user, stranger] = await walletClient.getAddresses();

  const beesDeployed = await deployArtifact('BEES', [owner]);
  beesAddress = beesDeployed.address;
  bees = getContract({
    address: beesAddress,
    abi: beesDeployed.abi,
    client: { public: publicClient, wallet: walletClient },
  });

  const faucetDeployed = await deployArtifact('HabitraBeesFaucet', [beesAddress, owner, CLAIM]);
  faucetAddress = faucetDeployed.address;
  faucet = getContract({
    address: faucetAddress,
    abi: faucetDeployed.abi,
    client: { public: publicClient, wallet: walletClient },
  });

  // Fund the faucet (owner mints BEES to it — the same path the real deploy uses).
  await bees.write.mint([faucetAddress, FUND], { account: owner });
}

describe('HabitraBeesFaucet', () => {
  beforeEach(setup);

  it('records the configured BEES token and claim amount', async () => {
    assert.equal((await faucet.read.bees()).toLowerCase(), beesAddress.toLowerCase());
    assert.equal(await faucet.read.claimAmount(), CLAIM);
    assert.equal(await bees.read.balanceOf([faucetAddress]), FUND);
  });

  it('lets a new address claim once and records the claim', async () => {
    const before = await bees.read.balanceOf([user]);
    await faucet.write.claim({ account: user });

    assert.equal(await bees.read.balanceOf([user]), before + CLAIM);
    assert.equal(await faucet.read.hasClaimed([user]), true);
    assert.equal(await faucet.read.totalClaimed(), CLAIM);
  });

  it('rejects a second claim by the same address', async () => {
    await faucet.write.claim({ account: user });
    await expectRevert(faucet.write.claim({ account: user }), 'AlreadyClaimed');
    // Still only one claim recorded.
    assert.equal(await faucet.read.hasClaimed([user]), true);
    assert.equal(await faucet.read.totalClaimed(), CLAIM);
  });

  it('rejects a claim when the faucet is empty', async () => {
    const emptyDeployed = await deployArtifact('HabitraBeesFaucet', [beesAddress, owner, CLAIM]);
    const emptyFaucet = getContract({
      address: emptyDeployed.address,
      abi: emptyDeployed.abi,
      client: { public: publicClient, wallet: walletClient },
    });
    await expectRevert(emptyFaucet.write.claim({ account: user }), 'FaucetEmpty');
    assert.equal(await bees.read.balanceOf([emptyDeployed.address]), 0n);
  });

  it('lets a different address claim independently', async () => {
    await faucet.write.claim({ account: user });
    const strangerBefore = await bees.read.balanceOf([stranger]);
    await faucet.write.claim({ account: stranger });
    assert.equal(await bees.read.balanceOf([stranger]), strangerBefore + CLAIM);
    assert.equal(await faucet.read.totalClaimed(), CLAIM * 2n);
  });

  it('lets the owner withdraw remaining BEES', async () => {
    await faucet.write.claim({ account: user });
    const ownerBefore = await bees.read.balanceOf([owner]);
    await faucet.write.withdraw({ account: owner });
    assert.equal(await bees.read.balanceOf([owner]), ownerBefore + (FUND - CLAIM));
    assert.equal(await bees.read.balanceOf([faucetAddress]), 0n);
  });

  it('rejects withdraw by a non-owner', async () => {
    await expectRevert(faucet.write.withdraw({ account: stranger }), /revert/i);
  });

  // --- Server-side distribution (claimFor) -----------------------------------
  it('lets the owner distribute 10 BEES to a pasted address once', async () => {
    const before = await bees.read.balanceOf([stranger]);
    await faucet.write.claimFor([stranger], { account: owner });

    assert.equal(await bees.read.balanceOf([stranger]), before + CLAIM);
    assert.equal(await faucet.read.hasClaimed([stranger]), true);
    assert.equal(await faucet.read.totalClaimed(), CLAIM);
  });

  it('rejects claimFor by a non-owner', async () => {
    await expectRevert(
      faucet.write.claimFor([stranger], { account: stranger }),
      /revert/i,
    );
  });

  it('rejects claimFor to the zero address', async () => {
    await expectRevert(
      faucet.write.claimFor(['0x0000000000000000000000000000000000000000'], { account: owner }),
      'ZeroAddress',
    );
  });

  it('rejects a second claimFor to the same address (AlreadyClaimed)', async () => {
    await faucet.write.claimFor([user], { account: owner });
    await expectRevert(faucet.write.claimFor([user], { account: owner }), 'AlreadyClaimed');
    assert.equal(await faucet.read.totalClaimed(), CLAIM);
  });

  it('treats claim() and claimFor() as the same one-claim guard', async () => {
    // user claims for themselves via the wallet path...
    await faucet.write.claim({ account: user });
    // ...so the owner cannot also distribute to that same address through the
    // server-side path. Both paths update the same hasClaimed[user] mapping.
    await expectRevert(faucet.write.claimFor([user], { account: owner }), 'AlreadyClaimed');
    assert.equal(await faucet.read.hasClaimed([user]), true);
  });
});

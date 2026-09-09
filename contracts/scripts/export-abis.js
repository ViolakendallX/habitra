/**
 * Exports the compiled contract ABIs as TypeScript constants for the existing
 * Node/TS backend and the Vite/React frontend.
 *
 * Run after `npm run compile`:
 *   node scripts/export-abis.js
 *
 * Outputs (generated — do not edit by hand):
 *   ../backend/src/contracts/abi.ts
 *   ../frontend/src/lib/contracts/abi.ts
 *
 * The two outputs are intentionally identical so the backend and the frontend
 * share one ABI definition without a build-time dependency between packages.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTRACTS = [
  { artifact: 'BEES', constName: 'beesAbi', typeName: 'BeesAbi' },
  {
    artifact: 'HabitraChallengeEscrow',
    constName: 'habitraChallengeEscrowAbi',
    typeName: 'HabitraChallengeEscrowAbi',
  },
];

const root = path.resolve(__dirname, '..');
const artifactsDir = path.join(root, 'artifacts', 'src');

function readAbi(artifactName) {
  const artifactPath = path.join(artifactsDir, `${artifactName}.sol`, `${artifactName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Missing artifact ${artifactPath}. Run "npm run compile" in contracts/ first.`,
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi;
}

function render(relativeNote) {
  const blocks = CONTRACTS.map(
    ({ artifact, constName }) =>
      `export const ${constName} = ${JSON.stringify(readAbi(artifact), null, 2)} as const;`,
  );
  const types = CONTRACTS.map(
    ({ constName, typeName }) => `export type ${typeName} = typeof ${constName};`,
  );

  return [
    '/**',
    ' * AUTO-GENERATED FILE — do not edit by hand.',
    ' *',
    ` * Source: ${relativeNote}`,
    ' * Regenerate with: (cd contracts && npm run compile && node scripts/export-abis.js)',
    ' *',
    ' * Typed as `as const` so viem can infer function names, argument types and',
    ' * return types without a codegen step.',
    ' */',
    '',
    ...blocks,
    '',
    ...types,
    '',
  ].join('\n');
}

const targets = [
  path.resolve(root, '..', 'backend', 'src', 'contracts', 'abi.ts'),
  path.resolve(root, '..', 'frontend', 'src', 'lib', 'contracts', 'abi.ts'),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render('contracts/artifacts (Hardhat)'), 'utf8');
  console.log('Wrote', path.relative(process.cwd(), target));
}

import { spawnSync } from 'node:child_process';

const tests = [
  'test/test-transform.js',
  'test/test-cloudcode-routing.js',
  'test/test-requester-routing.js',
  'test/test-go-cloudcode-requester.js',
  'test/test-request-identity.js',
  'test/test-thought-signature.js',
  'test/test-tool-protocol-integrity.js',
  'test/test-token-rotation-polling.js',
  'test/test-quota-exhausted-cascade.js'
];

for (const testFile of tests) {
  console.log(`\n=== ${testFile} ===`);
  const result = spawnSync(process.execPath, [testFile], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\nall unit tests passed');

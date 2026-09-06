import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../src/process.js';

test('runCommand preserves argument boundaries', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; c']);
  assert.equal(result.stdout, 'a b; c');
});

test('runCommand reports nonzero exits', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.stderr.write("failure"); process.exit(3)']),
    /command failed \(3\)/,
  );
});

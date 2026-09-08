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

test('runCommand streams complete stdout separately from bounded capture and stderr', async () => {
  const chunks: Buffer[] = [];
  const result = await runCommand(process.execPath, ['-e',
    'process.stdout.write("x".repeat(6 * 1024 * 1024) + "FINAL"); process.stderr.write("error");',
  ], { onStdout: (chunk) => { chunks.push(chunk); } });
  assert.equal(result.stdout.length, 5 * 1024 * 1024);
  assert.equal(Buffer.concat(chunks).toString(), 'x'.repeat(6 * 1024 * 1024) + 'FINAL');
  assert.equal(result.stderr, 'error');
});

test('runCommand rejects streaming callback failures without an uncaught exception', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e',
    'process.stdout.write("start"); setInterval(() => {}, 1000);',
  ], { timeoutMs: 1_000, onStdout: () => { throw new Error('stream consumer failed'); } }), /stream consumer failed/);
});

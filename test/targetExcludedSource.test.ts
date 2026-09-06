import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsTargetIdentityLeak,
  createTargetExcludedSourceSnapshot,
  verifyTargetExcludedSourceSnapshot,
} from '../src/targetExcludedSource.js';

const targetWorkflow = 'trumark/deceased-accounts';

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function writeFixture(root: string, relativePath: string, contents: string | Buffer): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

test('creates a physical source snapshot without target registration evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-source-'));
  const sourceRoot = path.join(root, 'frozen-workflows');
  const snapshotRoot = path.join(root, 'snapshot');
  const binary = Buffer.concat([Buffer.from([0]), Buffer.from(targetWorkflow)]);
  await Promise.all([
    writeFixture(sourceRoot, '.git/config', '[core]\nrepositoryformatversion = 0\n'),
    writeFixture(sourceRoot, '.harness/bundle-catalog.json', '{"workflows":[]}\n'),
    writeFixture(
      sourceRoot,
      'src/customers/trumark/deceased-accounts/workflow.ts',
      'export const workflow = true;\n',
    ),
    writeFixture(sourceRoot, 'src/customers/trumark/shared.ts', 'export const shared = true;\n'),
    writeFixture(sourceRoot, 'src/registry.ts', `register('${targetWorkflow}');\n`),
    writeFixture(
      sourceRoot,
      'docs/source-root.txt',
      'Implementation: src/customers/trumark/deceased-accounts/\n',
    ),
    writeFixture(sourceRoot, 'README.md', 'Shared workflow documentation.\n'),
    writeFixture(sourceRoot, 'assets/opaque.bin', binary),
  ]);

  try {
    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
    });

    assert.equal(await readFile(path.join(snapshotRoot, 'README.md'), 'utf8'), 'Shared workflow documentation.\n');
    assert.equal(
      await readFile(path.join(snapshotRoot, 'src/customers/trumark/shared.ts'), 'utf8'),
      'export const shared = true;\n',
    );
    assert.deepEqual(await readFile(path.join(snapshotRoot, 'assets/opaque.bin')), binary);
    await assert.rejects(readFile(path.join(snapshotRoot, '.git/config')), /ENOENT/);
    await assert.rejects(readFile(path.join(snapshotRoot, '.harness/bundle-catalog.json')), /ENOENT/);
    await assert.rejects(
      readFile(path.join(snapshotRoot, 'src/customers/trumark/deceased-accounts/workflow.ts')),
      /ENOENT/,
    );
    await assert.rejects(readFile(path.join(snapshotRoot, 'src/registry.ts')), /ENOENT/);
    await assert.rejects(readFile(path.join(snapshotRoot, 'docs/source-root.txt')), /ENOENT/);

    assert.deepEqual(manifest, {
      included: [
        { path: 'README.md', sha256: sha256('Shared workflow documentation.\n') },
        { path: 'assets/opaque.bin', sha256: sha256(binary) },
        {
          path: 'src/customers/trumark/shared.ts',
          sha256: sha256('export const shared = true;\n'),
        },
      ],
      excluded: [
        { path: '.git/', reason: 'git-metadata' },
        { path: '.harness/bundle-catalog.json', reason: 'bundle-catalog' },
        { path: 'docs/source-root.txt', reason: 'target-identity' },
        { path: 'src/customers/trumark/deceased-accounts/', reason: 'target-root' },
        { path: 'src/registry.ts', reason: 'target-identity' },
      ],
    });
    await verifyTargetExcludedSourceSnapshot({ snapshotRoot, targetWorkflow, expectedManifest: manifest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns the same manifest regardless of source directory insertion order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-determinism-'));
  const firstSource = path.join(root, 'first');
  const secondSource = path.join(root, 'second');
  try {
    await writeFixture(firstSource, 'z-last.txt', 'last\n');
    await writeFixture(firstSource, 'a-first.txt', 'first\n');
    await writeFixture(secondSource, 'a-first.txt', 'first\n');
    await writeFixture(secondSource, 'z-last.txt', 'last\n');

    const first = await createTargetExcludedSourceSnapshot({
      sourceRoot: firstSource,
      snapshotRoot: path.join(root, 'first-snapshot'),
      targetWorkflow,
    });
    const second = await createTargetExcludedSourceSnapshot({
      sourceRoot: secondSource,
      snapshotRoot: path.join(root, 'second-snapshot'),
      targetWorkflow,
    });

    assert.deepEqual(first, second);
    assert.deepEqual(first.included.map((entry) => entry.path), ['a-first.txt', 'z-last.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects source symlinks rather than following them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-symlink-'));
  const sourceRoot = path.join(root, 'source');
  try {
    await writeFixture(sourceRoot, 'shared.txt', 'safe\n');
    await symlink(path.join(root, 'outside.txt'), path.join(sourceRoot, 'shared-link'));

    await assert.rejects(
      createTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot: path.join(root, 'snapshot'),
        targetWorkflow,
      }),
      /symlink.*shared-link/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsafe target traversal and overlapping snapshot paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-traversal-'));
  const sourceRoot = path.join(root, 'source');
  try {
    await writeFixture(sourceRoot, 'shared.txt', 'safe\n');
    await assert.rejects(
      createTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot: path.join(root, 'snapshot'),
        targetWorkflow: '../trumark/deceased-accounts',
      }),
      /unsafe target workflow/i,
    );
    await assert.rejects(
      createTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot: path.join(sourceRoot, 'snapshot'),
        targetWorkflow,
      }),
      /must not overlap/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects exact target identity or canonical root leakage in arbitrary evidence JSON', () => {
  assert.equal(
    containsTargetIdentityLeak(
      { answer: { evidence: [{ source: `src/customers/${targetWorkflow}/workflow.ts` }] } },
      targetWorkflow,
    ),
    true,
  );
  assert.equal(
    containsTargetIdentityLeak({ [`registration:${targetWorkflow}`]: { present: true } }, targetWorkflow),
    true,
  );
  assert.equal(
    containsTargetIdentityLeak(
      { answer: 'trumark deceased-accounts', evidence: ['TRUMARK/DECEASED-ACCOUNTS'] },
      targetWorkflow,
    ),
    false,
  );
  assert.equal(
    containsTargetIdentityLeak(
      { evidence: ['src/customers/trumark/deceased-accounts-trigger/index.ts'] },
      targetWorkflow,
    ),
    false,
  );
});

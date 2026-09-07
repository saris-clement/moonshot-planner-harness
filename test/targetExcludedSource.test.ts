import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsTargetIdentityLeak,
  createTargetExcludedSourceSnapshot,
  isV2TargetIdentitySourceCandidate,
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

test('creates a hardened V2 source snapshot without target registration evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-source-'));
  const sourceRoot = path.join(root, 'frozen-workflows');
  const snapshotRoot = path.join(root, 'snapshot');
  const binary = Buffer.concat([Buffer.from([0]), Buffer.from(targetWorkflow)]);
  await Promise.all([
    writeFixture(sourceRoot, '.git/config', '[core]\nrepositoryformatversion = 0\n'),
    writeFixture(sourceRoot, '.harness/bundle-catalog.json', '{"workflows":[]}\n'),
    writeFixture(
      sourceRoot,
      'src/customers/trumark/Deceased-Accounts/workflow.ts',
      'export const workflow = true;\n',
    ),
    writeFixture(sourceRoot, 'src/customers/trumark/shared.ts', 'export const shared = true;\n'),
    writeFixture(sourceRoot, 'src/registry.ts', "register('TruMark/Deceased-Accounts');\n"),
    writeFixture(
      sourceRoot,
      'docs/source-root.txt',
      'Implementation: SRC/CUSTOMERS/TRUMARK/DECEASED-ACCOUNTS/\n',
    ),
    writeFixture(sourceRoot, 'README.md', 'Shared workflow documentation.\n'),
    writeFixture(sourceRoot, 'assets/opaque.bin', binary),
  ]);

  try {
    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
    });

    assert.equal(await readFile(path.join(snapshotRoot, 'README.md'), 'utf8'), 'Shared workflow documentation.\n');
    assert.equal(
      await readFile(path.join(snapshotRoot, 'src/customers/trumark/shared.ts'), 'utf8'),
      'export const shared = true;\n',
    );
    await assert.rejects(readFile(path.join(snapshotRoot, 'assets/opaque.bin')), /ENOENT/);
    await assert.rejects(readFile(path.join(snapshotRoot, '.git/config')), /ENOENT/);
    await assert.rejects(readFile(path.join(snapshotRoot, '.harness/bundle-catalog.json')), /ENOENT/);
    await assert.rejects(
      readFile(path.join(snapshotRoot, 'src/customers/trumark/Deceased-Accounts/workflow.ts')),
      /ENOENT/,
    );
    await assert.rejects(readFile(path.join(snapshotRoot, 'src/registry.ts')), /ENOENT/);
    await assert.rejects(readFile(path.join(snapshotRoot, 'docs/source-root.txt')), /ENOENT/);

    assert.deepEqual(manifest, {
      policyVersion: 2,
      included: [
        { path: 'README.md', sha256: sha256('Shared workflow documentation.\n') },
        {
          path: 'src/customers/trumark/shared.ts',
          sha256: sha256('export const shared = true;\n'),
        },
      ],
      excluded: [
        { path: '.git/', reason: 'git-metadata' },
        { path: '.harness/bundle-catalog.json', reason: 'bundle-catalog' },
        { path: 'assets/opaque.bin', reason: 'opaque-content' },
        { path: 'docs/source-root.txt', reason: 'target-identity' },
        { path: 'src/customers/trumark/Deceased-Accounts/', reason: 'target-root' },
        { path: 'src/registry.ts', reason: 'target-identity' },
      ],
    });
    await verifyTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
      expectedManifest: manifest,
    });
    await verifyTargetExcludedSourceSnapshot({ sourceRoot, snapshotRoot, targetWorkflow, expectedManifest: manifest });
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
      policyVersion: 2,
    });
    const second = await createTargetExcludedSourceSnapshot({
      sourceRoot: secondSource,
      snapshotRoot: path.join(root, 'second-snapshot'),
      targetWorkflow,
      policyVersion: 2,
    });

    assert.deepEqual(first, second);
    assert.deepEqual(first.included.map((entry) => entry.path), ['a-first.txt', 'z-last.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('binds the snapshot and manifest to the unchanged frozen source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-authority-'));
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const relativePath = 'src/shared.ts';
  const original = 'export const shared = true;\n';
  const tampered = 'export const shared = false;\n';

  try {
    await writeFixture(sourceRoot, relativePath, original);
    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
    });
    await verifyTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
      expectedManifest: manifest,
    });

    const snapshotFile = path.join(snapshotRoot, relativePath);
    await rm(snapshotFile);
    await writeFile(snapshotFile, tampered);
    const jointlyTamperedManifest = {
      ...manifest,
      included: [{ path: relativePath, sha256: sha256(tampered) }],
    };
    await assert.rejects(
      verifyTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot,
        targetWorkflow,
        policyVersion: 2,
        expectedManifest: jointlyTamperedManifest,
      }),
      /frozen source manifest/i,
    );

    await rm(snapshotFile);
    await writeFile(snapshotFile, original);
    await writeFile(path.join(sourceRoot, relativePath), tampered);
    await assert.rejects(
      verifyTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot,
        targetWorkflow,
        policyVersion: 2,
        expectedManifest: manifest,
      }),
      /frozen source manifest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 excludes target-named directories without traversing them and rejects opaque content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-v2-opaque-'));
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const shared = 'shared text remains available\n';
  const opaqueTarget = Buffer.concat([Buffer.from([0]), Buffer.from(targetWorkflow)]);

  try {
    await Promise.all([
      writeFixture(sourceRoot, 'README.md', shared),
      writeFixture(sourceRoot, 'archives/other/deceased-accounts/shared.txt', 'other customer\n'),
      writeFixture(sourceRoot, 'archives/trumark/deceased-accounts-trigger/shared.txt', 'suffix control\n'),
      writeFixture(sourceRoot, 'archives/trumark/deceased-accounts/nested/hidden.ts', 'export const hidden = true;\n'),
      writeFixture(sourceRoot, 'assets/invalid-utf8.bin', Buffer.from([0xff, 0xfe])),
      writeFixture(sourceRoot, 'assets/opaque-target.bin', opaqueTarget),
    ]);

    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
    });

    assert.deepEqual(manifest, {
      policyVersion: 2,
      included: [
        { path: 'README.md', sha256: sha256(shared) },
        { path: 'archives/other/deceased-accounts/shared.txt', sha256: sha256('other customer\n') },
        { path: 'archives/trumark/deceased-accounts-trigger/shared.txt', sha256: sha256('suffix control\n') },
      ],
      excluded: [
        { path: 'archives/trumark/deceased-accounts/', reason: 'target-identity' },
        { path: 'assets/invalid-utf8.bin', reason: 'opaque-content' },
        { path: 'assets/opaque-target.bin', reason: 'opaque-content' },
      ],
    });
    await verifyTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
      expectedManifest: manifest,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('excludes JavaScript and TypeScript sources with relative module references into the target root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-relative-import-'));
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const references = new Map([
    ['src/alias-import.ts', "import { workflow } from '@customers/trumark/deceased-accounts/workflow.js';\n"],
    ['src/alias-string.ts', "export const targetPath = '/mounted/workflows/trumark/deceased-accounts/index.js';\n"],
    ['src/customers/trumark/import-consumer.ts', "import { workflow } from './deceased-accounts/workflow.js';\n"],
    ['src/customers/trumark/export-consumer.ts', "export { workflow } from './deceased-accounts/workflow.js';\n"],
    ['src/customers/trumark/require-consumer.cjs', "const workflow = require('./deceased-accounts/workflow.js');\n"],
    ['src/customers/trumark/dynamic-consumer.mts', "const workflow = import('./deceased-accounts/workflow.js');\n"],
  ]);

  try {
    await Promise.all([
      ...[...references.entries()].map(([relativePath, contents]) =>
        writeFixture(sourceRoot, relativePath, contents),
      ),
      writeFixture(
        sourceRoot,
        'src/customers/trumark/deceased-accounts/workflow.ts',
        'export const workflow = true;\n',
      ),
    ]);

    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
    });

    assert.equal(manifest.policyVersion, 2);
    assert.deepEqual(manifest.included, []);
    assert.deepEqual(manifest.excluded, [
      { path: 'src/customers/trumark/deceased-accounts/', reason: 'target-root' },
      ...[...references.keys()]
        .sort()
        .map((relativePath) => ({ path: relativePath, reason: 'target-identity' as const })),
    ].sort((left, right) => left.path.localeCompare(right.path)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps relative imports with the target basename outside the target customer root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-unrelated-import-'));
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const consumer = "import { workflow } from './deceased-accounts/workflow.js';\n";
  const workflow = 'export const workflow = true;\n';
  const prefixControl = "export const alias = '@customers/xtrumark/deceased-accounts';\n";
  const suffixControl = "export const alias = '@customers/trumark/deceased-accounts-extra';\n";

  try {
    await Promise.all([
      writeFixture(sourceRoot, 'src/customers/other/consumer.ts', consumer),
      writeFixture(sourceRoot, 'src/customers/other/deceased-accounts/workflow.ts', workflow),
      writeFixture(sourceRoot, 'src/prefix-control.ts', prefixControl),
      writeFixture(sourceRoot, 'src/suffix-control.ts', suffixControl),
    ]);

    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
    });

    assert.deepEqual(manifest, {
      policyVersion: 2,
      included: [
        { path: 'src/customers/other/consumer.ts', sha256: sha256(consumer) },
        { path: 'src/customers/other/deceased-accounts/workflow.ts', sha256: sha256(workflow) },
        { path: 'src/prefix-control.ts', sha256: sha256(prefixControl) },
        { path: 'src/suffix-control.ts', sha256: sha256(suffixControl) },
      ],
      excluded: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves the exact legacy V1 manifest shape and filtering behavior', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-v1-'));
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const opaque = Buffer.concat([Buffer.from([0]), Buffer.from(targetWorkflow)]);
  const mixedRoot = 'export const workflow = true;\n';
  const relativeImport = "import { workflow } from './Deceased-Accounts/workflow.js';\n";
  const mixedRegistration = "register('TruMark/Deceased-Accounts');\n";
  const mixedCanonicalRoot = 'Implementation: SRC/CUSTOMERS/TRUMARK/DECEASED-ACCOUNTS/\n';
  const legacyTargetPath = 'legacy target-named path remains available\n';
  const legacyAlias = "export const alias = '@customers/trumark/deceased-accounts/index.js';\n";

  try {
    await Promise.all([
      writeFixture(sourceRoot, '.git/config', '[core]\nrepositoryformatversion = 0\n'),
      writeFixture(sourceRoot, '.harness/bundle-catalog.json', '{"workflows":[]}\n'),
      writeFixture(sourceRoot, 'README.md', 'Shared workflow documentation.\n'),
      writeFixture(sourceRoot, 'assets/invalid-utf8.bin', Buffer.from([0xff, 0xfe])),
      writeFixture(sourceRoot, 'assets/opaque.bin', opaque),
      writeFixture(sourceRoot, 'docs/source-root.txt', mixedCanonicalRoot),
      writeFixture(sourceRoot, 'evidence@trumark/deceased-accounts@opaque.bin', opaque),
      writeFixture(sourceRoot, 'src/customers/trumark/Deceased-Accounts/workflow.ts', mixedRoot),
      writeFixture(sourceRoot, 'src/customers/trumark/relative.ts', relativeImport),
      writeFixture(sourceRoot, 'src/exact-registry.ts', `register('${targetWorkflow}');\n`),
      writeFixture(sourceRoot, 'src/legacy-alias.ts', legacyAlias),
      writeFixture(sourceRoot, 'src/registry.ts', mixedRegistration),
      writeFixture(sourceRoot, 'trumark/deceased-accounts/shared.txt', legacyTargetPath),
    ]);

    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 1,
    });
    const expectedManifest = {
      included: [
        { path: 'README.md', sha256: sha256('Shared workflow documentation.\n') },
        { path: 'assets/invalid-utf8.bin', sha256: sha256(Buffer.from([0xff, 0xfe])) },
        { path: 'assets/opaque.bin', sha256: sha256(opaque) },
        { path: 'docs/source-root.txt', sha256: sha256(mixedCanonicalRoot) },
        { path: 'evidence@trumark/deceased-accounts@opaque.bin', sha256: sha256(opaque) },
        { path: 'src/customers/trumark/Deceased-Accounts/workflow.ts', sha256: sha256(mixedRoot) },
        { path: 'src/customers/trumark/relative.ts', sha256: sha256(relativeImport) },
        { path: 'src/legacy-alias.ts', sha256: sha256(legacyAlias) },
        { path: 'src/registry.ts', sha256: sha256(mixedRegistration) },
        { path: 'trumark/deceased-accounts/shared.txt', sha256: sha256(legacyTargetPath) },
      ],
      excluded: [
        { path: '.git/', reason: 'git-metadata' as const },
        { path: '.harness/bundle-catalog.json', reason: 'bundle-catalog' as const },
        { path: 'src/exact-registry.ts', reason: 'target-identity' as const },
      ],
    };

    assert.equal(JSON.stringify(manifest), JSON.stringify(expectedManifest));
    assert.equal('policyVersion' in manifest, false);
    await verifyTargetExcludedSourceSnapshot({ sourceRoot, snapshotRoot, targetWorkflow, expectedManifest });
    await verifyTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 1,
      expectedManifest,
    });
    await assert.rejects(
      verifyTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot,
        targetWorkflow,
        policyVersion: 2,
        expectedManifest,
      }),
      /policy version mismatch/i,
    );
    await assert.rejects(
      verifyTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot,
        targetWorkflow,
        expectedManifest: { ...expectedManifest, policyVersion: 3 as 2 },
      }),
      /unsupported manifest policy version/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 excludes bounded target identities in textual and opaque file paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-v2-path-'));
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const opaque = Buffer.concat([Buffer.from([0]), Buffer.from(targetWorkflow)]);

  try {
    await Promise.all([
      writeFixture(sourceRoot, 'assets/opaque.bin', opaque),
      writeFixture(sourceRoot, 'evidence@trumark/Deceased-Accounts@notes.txt', 'safe notes\n'),
      writeFixture(sourceRoot, 'evidence@trumark/deceased-accounts@opaque.bin', Buffer.from([0, 1, 2])),
    ]);

    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot,
      targetWorkflow,
      policyVersion: 2,
    });

    assert.deepEqual(manifest, {
      policyVersion: 2,
      included: [],
      excluded: [
        { path: 'assets/opaque.bin', reason: 'opaque-content' },
        { path: 'evidence@trumark/Deceased-Accounts@notes.txt', reason: 'target-identity' },
        { path: 'evidence@trumark/deceased-accounts@opaque.bin', reason: 'target-identity' },
      ],
    });
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
        policyVersion: 2,
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
        policyVersion: 2,
      }),
      /unsafe target workflow/i,
    );
    await assert.rejects(
      createTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot: path.join(root, 'snapshot'),
        targetWorkflow,
        policyVersion: 3 as 2,
      }),
      /unsupported policy version/i,
    );
    await assert.rejects(
      createTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot: path.join(sourceRoot, 'snapshot'),
        targetWorkflow,
        policyVersion: 2,
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
    true,
  );
  assert.equal(
    containsTargetIdentityLeak(
      {
        module: '@customers/TRUMARK/DECEASED-ACCOUNTS',
        nested: { '/absolute/prefix/trumark/deceased-accounts/workflow.ts': true },
      },
      targetWorkflow,
    ),
    true,
  );
  assert.equal(
    containsTargetIdentityLeak(
      { evidence: ['SRC/CUSTOMERS/TRUMARK/DECEASED-ACCOUNTS-TRIGGER/index.ts'] },
      targetWorkflow,
    ),
    false,
  );
  assert.equal(
    containsTargetIdentityLeak(
      {
        prefix: '@customers/xtrumark/deceased-accounts',
        suffix: '/absolute/trumark/deceased-accounts-extra/workflow.ts',
      },
      targetWorkflow,
    ),
    false,
  );
});

test('classifies one textual V2 source candidate with path-aware target checks', () => {
  assert.equal(
    isV2TargetIdentitySourceCandidate({
      relativePath: 'archives/trumark/deceased-accounts/shared.ts',
      text: 'export const shared = true;\n',
      targetWorkflow,
    }),
    true,
  );
  assert.equal(
    isV2TargetIdentitySourceCandidate({
      relativePath: 'src/registry.ts',
      text: "register('TRUMARK/DECEASED-ACCOUNTS');\n",
      targetWorkflow,
    }),
    true,
  );
  assert.equal(
    isV2TargetIdentitySourceCandidate({
      relativePath: 'src/customers/trumark/shared.ts',
      text: "export { workflow } from './deceased-accounts/workflow.js';\n",
      targetWorkflow,
    }),
    true,
  );
  assert.equal(
    isV2TargetIdentitySourceCandidate({
      relativePath: 'src/shared.ts',
      text: "import { workflow } from '@customers/trumark/deceased-accounts/workflow.js';\n",
      targetWorkflow,
    }),
    true,
  );
  assert.equal(
    isV2TargetIdentitySourceCandidate({
      relativePath: 'archives/trumark/deceased-accounts-trigger/shared.ts',
      text: "import { workflow } from '../../other/deceased-accounts/workflow.js';\n",
      targetWorkflow,
    }),
    false,
  );
});

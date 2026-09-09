import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRunner } from '../src/agents.js';
import {
  CampaignConfigSchema,
  DiagnosisInputSchema,
  type CampaignRecord,
  type VariantRecord,
} from '../src/types.js';
import { runCommand, type CommandResult } from '../src/process.js';

const config = CampaignConfigSchema.parse({
  id: 'agent-repair',
  goal: 'Verify structured source answers recover from progress-only model output.',
  plannerRepo: '/tmp/planner',
  workflowsRepo: '/tmp/workflows',
  environmentFile: '/tmp/environment.env',
  seedRevision: 'seed',
  workflowsRevision: 'workflows',
  benchmarks: [
    { name: 'primary', role: 'primary', zipPath: '/tmp/primary.zip' },
    { name: 'holdout', role: 'holdout', zipPath: '/tmp/holdout.zip' },
  ],
});

const campaign: CampaignRecord = {
  id: config.id,
  status: 'ready',
  config,
  seedSha: 'a'.repeat(40),
  workflowsSha: 'b'.repeat(40),
  environmentSha: `sha256:${'c'.repeat(64)}`,
  workflowsRemoteUrl: 'https://github.com/Saris-AI/workflows.git',
  currentParentVariantId: null,
  noImprovementRounds: 0,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
};

test('source-answer agent retries progress-only output with a JSON repair request', async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'source-answer-source-'));
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'source-answer-artifacts-'));
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); });
  const calls: string[][] = [];
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  const outputs = [
    'I am tracing the source before answering.',
    '{"resolution":"answered","answer":"Use the shared format.","evidence":["src/shared.ts:1"]}',
  ];
  const runner = new AgentRunner(campaign, async (command, args, options): Promise<CommandResult> => {
    if (command === 'git') return await runCommand(command, args, options);
    if (args.includes('debug')) return { command, args: [...args], exitCode: 0, stderr: '', durationMs: 1,
      stdout: args.includes('config') ? '{}' : `data       ${os.homedir()}/.local/share/opencode\n` };
    calls.push([...args]);
    environments.push(options?.env);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: outputs[calls.length - 1]!,
      stderr: '',
      durationMs: 1,
    };
  });

  const answer = await runner.answerUpstreamQuestion(
    { id: 'question-a', question: 'Which format?', type: 'free_text', options: [] },
    source,
    artifacts,
  );

  assert.equal(calls.length, 2);
  assert.ok(environments[0]?.GIT_CEILING_DIRECTORIES?.split(path.delimiter).includes(path.dirname(source)));
  assert.ok(environments[1]?.GIT_CEILING_DIRECTORIES?.split(path.delimiter).includes(path.dirname(source)));
  assert.match(calls[0]!.join(' '), /current working directory as a hard source boundary/i);
  assert.match(calls[0]!.join(' '), /Do not inspect parent, sibling, or external paths/i);
  assert.match(calls[0]!.join(' '), /Use only behavior and deployment facts proven by source/);
  assert.match(
    calls[0]!.join(' '),
    /Return unresolved only when source cannot establish the implementation's operational behavior or a safe read\/write boundary at all/,
  );
  assert.match(calls[1]!.join(' '), /previous response was not valid JSON/);
  assert.equal(answer.resolution, 'answered');
});

test('pm-simulation source-answer prompt keeps implementation private and evidence harness-only', async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'source-answer-pm-source-'));
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'source-answer-pm-artifacts-'));
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); });
  const calls: string[][] = [];
  const runner = new AgentRunner(campaign, async (command, args, options): Promise<CommandResult> => {
    if (command === 'git') return await runCommand(command, args, options);
    if (args.includes('debug')) return { command, args: [...args], exitCode: 0, stderr: '', durationMs: 1,
      stdout: args.includes('config') ? '{}' : `data       ${os.homedir()}/.local/share/opencode\n` };
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: JSON.stringify({
        resolution: 'answered',
        answer: 'Use the managed operating model.',
        evidence: ['src/operations.ts:42'],
      }),
      stderr: '',
      durationMs: 1,
    };
  });

  const answer = await runner.answerUpstreamQuestion(
    { id: 'question-pm', question: 'Which operating model?', type: 'free_text', options: [] },
    source,
    artifacts,
    { mode: 'pm-simulation' },
  );

  const prompt = calls[0]!.join(' ');
  assert.equal(answer.resolution, 'answered');
  assert.match(prompt, /full frozen implementation as private context/i);
  assert.match(prompt, /act like a real PM/i);
  assert.match(prompt, /intended product or operational decision/i);
  assert.match(prompt, /concise human answer/i);
  assert.match(prompt, /maximum of 3 sentences|max 3 sentences/i);
  assert.match(prompt, /exact endpoint, profile, service identity, or secret/i);
  assert.match(prompt, /exact value is deployment-provided/i);
  assert.match(prompt, /do not return unresolved merely because that deployment value is absent/i);
  assert.match(prompt, /source paths/i);
  assert.match(prompt, /symbols/i);
  assert.match(prompt, /capability IDs/i);
  assert.match(prompt, /workflow identity/i);
  assert.match(prompt, /implementation narration/i);
  assert.match(prompt, /evidence.*required/i);
  assert.match(prompt, /exact source paths/i);
  assert.match(prompt, /harness-only audit/i);
  assert.match(prompt, /evidence.*never planner-visible/i);
  assert.match(prompt, /current working directory as a hard source boundary/i);
  assert.match(prompt, /Do not inspect parent, sibling, or external paths/i);
  assert.match(prompt, /only native read.*directory listings and files/i);
  assert.match(prompt, /Do not.*edit.*network/i);
  assert.match(prompt, /"resolution":"answered"/);
  assert.match(prompt, /"resolution":"unresolved"/);
});

test('strategist prompt and schema require current diagnosis finding citations', async () => {
  const calls: string[][] = [];
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: JSON.stringify({
        hypotheses: [
          {
            title: 'Retain executable evidence',
            rationale: 'The cited diagnosis identified a bounded loss.',
            instructions: 'Preserve qualified executable declarations.',
            expectedImpact: 'Reduce unsupported build decisions.',
            risk: 'Could admit declarations without behavior.',
            findingIds: ['finding-hydration'],
            assumptions: ['The diagnosed evidence loss is causally relevant.'],
          },
        ],
      }),
      stderr: '',
      durationMs: 1,
    };
  });
  const hypotheses = await runner.proposeHypotheses(
    '/tmp',
    '/tmp/history.json',
    1,
    true,
    ['finding-hydration'],
  );
  assert.deepEqual(hypotheses[0]?.findingIds, ['finding-hydration']);
  assert.deepEqual(hypotheses[0]?.assumptions, [
    'The diagnosed evidence loss is causally relevant.',
  ]);
  assert.match(calls[0]!.join(' '), /real finding IDs/);
  assert.match(calls[0]!.join(' '), /counterevidence/);
  assert.match(calls[0]!.join(' '), /assumptions/);
  assert.match(calls[0]!.join(' '), /research.*historical context only/i);
  assert.match(calls[0]!.join(' '), /not current-run evidence/i);
  assert.match(calls[0]!.join(' '), /every material clause/i);
  assert.match(calls[0]!.join(' '), /campaign-level falsification/i);
  assert.match(calls[0]!.join(' '), /finding-hydration/);
});

test('strategist repairs stale diagnosis IDs against the current-parent allowlist', async () => {
  const calls: string[][] = [];
  const outputs = [
    {
      hypotheses: [
        {
          title: 'Stale finding',
          rationale: 'Incorrectly selected a sibling diagnosis.',
          instructions: 'Implement a stale mechanism.',
          expectedImpact: 'None.',
          risk: 'Stale context.',
          findingIds: ['finding-sibling'],
          assumptions: ['The stale finding belongs to the parent.'],
        },
      ],
    },
    {
      hypotheses: [
        {
          title: 'Current finding',
          rationale: 'Uses the current parent diagnosis.',
          instructions: 'Implement the current mechanism.',
          expectedImpact: 'A bounded measurable change.',
          risk: 'The mechanism may be wrong.',
          findingIds: ['finding-current'],
          assumptions: ['The current finding is causally relevant.'],
        },
      ],
    },
  ];
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: JSON.stringify(outputs[calls.length - 1]),
      stderr: '',
      durationMs: 1,
    };
  });

  const hypotheses = await runner.proposeHypotheses(
    '/tmp',
    '/tmp/history.json',
    1,
    true,
    ['finding-current'],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(hypotheses[0]?.findingIds, ['finding-current']);
  assert.match(calls[1]!.join(' '), /previous hypotheses cited stale or unknown finding IDs/i);
  assert.match(calls[1]!.join(' '), /finding-current/);
});

test('strategist output is rejected when it omits explicit assumptions', async () => {
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => ({
    command,
    args: [...args],
    exitCode: 0,
    stdout: JSON.stringify({
      hypotheses: [
        {
          title: 'Missing assumption',
          rationale: 'A bounded rationale.',
          instructions: 'Make one bounded change.',
          expectedImpact: 'A measurable change.',
          risk: 'The mechanism may be wrong.',
          findingIds: ['finding-hydration'],
        },
      ],
    }),
    stderr: '',
    durationMs: 1,
  }));

  await assert.rejects(
    runner.proposeHypotheses('/tmp', '/tmp/history.json', 1),
    /invalid structured output/,
  );
});

test('mutator prompt discloses the configured path allowlist', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-agent-paths-'));
  const contextPath = path.join(directory, 'mutation-context.json');
  await writeFile(contextPath, '{"selectedFindings":[]}\n');
  const scopedCampaign: CampaignRecord = {
    ...campaign,
    config: {
      ...campaign.config,
      gates: {
        ...campaign.config.gates,
        allowedPathPrefixes: ['server/src/custom/', 'server/test/custom/'],
      },
    },
  };
  let localContextPath: string | null = null;
  const runner = new AgentRunner(
    scopedCampaign,
    async (command, args): Promise<CommandResult> => {
      const attachmentIndex = args.indexOf('--file');
      localContextPath = args[attachmentIndex + 1] ?? null;
      assert.ok(localContextPath);
      assert.equal(path.dirname(localContextPath), directory);
      assert.notEqual(localContextPath, contextPath);
      assert.equal(await readFile(localContextPath, 'utf8'), '{"selectedFindings":[]}\n');
      return {
        command,
        args: [...args],
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      };
    },
  );
  const variant = {
    id: 'agent-paths-v001',
    hypothesis: {
      title: 'Bounded change',
      rationale: 'Exercise the configured mutation boundary.',
      instructions: 'Make one bounded change.',
      expectedImpact: 'A measurable result.',
      risk: 'The mechanism may be wrong.',
      findingIds: ['finding-hydration'],
    },
  } as VariantRecord;

  try {
    await runner.mutate(variant, directory, directory, contextPath);
    const prompt = await readFile(path.join(directory, 'mutator-prompt.txt'), 'utf8');
    assert.match(prompt, /server\/src\/custom\//);
    assert.match(prompt, /server\/test\/custom\//);
    assert.match(prompt, /rejected before tests or evaluation/);
    assert.match(prompt, /Do not stage changes or alter the Git index/);
    assert.match(prompt, /campaign-level empirical falsification/i);
    assert.match(prompt, /every material intervention clause/i);
    assert.equal(await stat(localContextPath!).catch(() => null), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hypothesis compliance reviewer binds its unverified verdict to patch and mutation context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-agent-compliance-'));
  const patchPath = path.join(directory, 'variant.patch');
  const mutationContextPath = path.join(directory, 'mutation-context.json');
  const patch = 'diff --git a/server/src/policy.ts b/server/src/policy.ts\n+export const policy = true;\n';
  const mutationContext = JSON.stringify({
    selectedFindings: [
      {
        genericIntervention: 'Retain executable evidence.',
        falsificationTest: 'Admit executable evidence while rejecting type-only aliases.',
      },
    ],
  });
  await Promise.all([
    writeFile(patchPath, patch),
    writeFile(mutationContextPath, mutationContext),
  ]);
  const patchSha256 = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
  const mutationContextSha256 = `sha256:${createHash('sha256')
    .update(mutationContext)
    .digest('hex')}`;
  const output = {
    kind: 'ainative-planner-eval/hypothesis-compliance',
    schemaVersion: 2,
    interpretationStatus: 'unverified_model_judgment',
    variantId: 'agent-repair-v001',
    patchSha256,
    mutationContextSha256,
    status: 'passed',
    summary: 'The implementation and regression test align with the selected finding.',
    intervention: {
      status: 'satisfied',
      rationale: 'The runtime path retains executable evidence.',
      evidence: ['server/src/policy.ts:1'],
    },
    codeRegression: {
      status: 'satisfied',
      rationale: 'The test covers the deterministic positive and negative boundary.',
      evidence: ['server/test/policy.test.ts:1'],
    },
    falsificationTest: {
      status: 'satisfied',
      rationale: 'The test covers admitted and rejected declarations.',
      evidence: ['server/test/policy.test.ts:1'],
    },
    limitations: ['This is an unverified model judgment.'],
  };
  const calls: string[][] = [];
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: calls.length === 1 ? 'I am reviewing the patch.' : JSON.stringify(output),
      stderr: '',
      durationMs: 1,
    };
  });
  const variant = {
    id: 'agent-repair-v001',
    hypothesis: {
      title: 'Retain evidence',
      rationale: 'Exercise the diagnosed admission loss.',
      instructions: 'Retain executable evidence and add the falsification regression.',
      expectedImpact: 'Fewer unsupported build decisions.',
      risk: 'Could admit declarations without behavior.',
      findingIds: ['finding-hydration'],
    },
  } as VariantRecord;

  try {
    const assessment = await runner.assessHypothesisCompliance(
      variant,
      patchPath,
      mutationContextPath,
      directory,
      directory,
    );
    assert.equal(assessment.result.status, 'passed');
    assert.equal(assessment.result.patchSha256, patchSha256);
    assert.equal(assessment.result.mutationContextSha256, mutationContextSha256);
    assert.match(calls[0]!.join(' '), /prompt-only change/i);
    assert.match(calls[0]!.join(' '), /invented fixture|current code contract/i);
    assert.match(calls[0]!.join(' '), /executable falsification/i);
    assert.match(calls[0]!.join(' '), /unverified model judgment/i);
    assert.match(calls[0]!.join(' '), /Do not modify files, the Git index, or HEAD/);
    assert.match(calls[0]!.join(' '), /Do not run host tests/);
    assert.match(calls[1]!.join(' '), /Do not run host tests/);
    assert.match(calls[0]!.join(' '), /deferred_to_evaluation/);
    const attachedPaths = calls[0]!
      .flatMap((value, index, values) => (value === '--file' ? [values[index + 1]!] : []));
    assert.equal(attachedPaths.length, 2);
    assert.ok(attachedPaths.every((value) => path.dirname(value) === directory));
    assert.ok(attachedPaths.every((value) => path.basename(value).startsWith('.harness-')));
    assert.match(calls[1]!.join(' '), /previous response did not satisfy/i);
    assert.match(await readFile(assessment.resultPath, 'utf8'), /hypothesis-compliance/);
    assert.ok(
      (await Promise.all(attachedPaths.map(async (value) => await stat(value).catch(() => null)))).every(
        (value) => value === null,
      ),
    );
    await assert.rejects(
      runner.assessHypothesisCompliance(
        variant,
        patchPath,
        mutationContextPath,
        directory,
        directory,
      ),
      /result exists without a trusted persisted hash/,
    );
    const resultBytes = await readFile(assessment.resultPath);
    const resultSha256 = `sha256:${createHash('sha256').update(resultBytes).digest('hex')}`;
    const reused = await runner.assessHypothesisCompliance(
      variant,
      patchPath,
      mutationContextPath,
      directory,
      directory,
      resultSha256,
    );
    assert.deepEqual(reused.result, assessment.result);
    await rm(assessment.resultPath);
    await assert.rejects(
      runner.assessHypothesisCompliance(
        variant,
        patchPath,
        mutationContextPath,
        directory,
        directory,
        resultSha256,
      ),
      /trusted persisted hypothesis compliance result is missing/,
    );

    const requiredContextPath = path.join(directory, 'required-mutation-context.json');
    const requiredContext = JSON.stringify({
      selectedFindings: [
        {
          id: 'finding-required-test',
          falsificationTest: 'Exercise both retained and rejected evidence.',
        },
      ],
    });
    await writeFile(requiredContextPath, requiredContext);
    const requiredContextSha256 = `sha256:${createHash('sha256')
      .update(requiredContext)
      .digest('hex')}`;
    const invalidRunner = new AgentRunner(
      campaign,
      async (command, args): Promise<CommandResult> => ({
        command,
        args: [...args],
        exitCode: 0,
        stdout: JSON.stringify({
          ...output,
          mutationContextSha256: requiredContextSha256,
          falsificationTest: {
            status: 'not_applicable',
            rationale: 'No test was checked.',
            evidence: ['mutation-context.json'],
          },
        }),
        stderr: '',
        durationMs: 1,
      }),
    );
    await assert.rejects(
      invalidRunner.assessHypothesisCompliance(
        variant,
        patchPath,
        requiredContextPath,
        directory,
        directory,
      ),
      /falsification check cannot be not_applicable/,
    );

    const tamperingRunner = new AgentRunner(
      campaign,
      async (command, args): Promise<CommandResult> => {
        const attachmentIndex = args.indexOf('--file');
        await writeFile(args[attachmentIndex + 1]!, 'tampered attachment');
        return {
          command,
          args: [...args],
          exitCode: 0,
          stdout: JSON.stringify(output),
          stderr: '',
          durationMs: 1,
        };
      },
    );
    await assert.rejects(
      tamperingRunner.assessHypothesisCompliance(
        variant,
        patchPath,
        mutationContextPath,
        directory,
        directory,
      ),
      /agent modified a local immutable attachment/,
    );
    const { codeRegression: _codeRegression, ...legacyOutput } = output;
    const legacyRunner = new AgentRunner(
      campaign,
      async (command, args): Promise<CommandResult> => ({
        command,
        args: [...args],
        exitCode: 0,
        stdout: JSON.stringify({ ...legacyOutput, schemaVersion: 1 }),
        stderr: '',
        durationMs: 1,
      }),
    );
    await assert.rejects(
      legacyRunner.assessHypothesisCompliance(
        variant,
        patchPath,
        mutationContextPath,
        directory,
        directory,
      ),
      /agent returned invalid structured output/,
    );
    let bindingCalls = 0;
    const bindingRunner = new AgentRunner(
      campaign,
      async (command, args): Promise<CommandResult> => {
        bindingCalls += 1;
        return {
          command,
          args: [...args],
          exitCode: 0,
          stdout: JSON.stringify(
            bindingCalls === 1 ? { ...output, variantId: 'wrong-variant' } : output,
          ),
          stderr: '',
          durationMs: 1,
        };
      },
    );
    const bindingRepaired = await bindingRunner.assessHypothesisCompliance(
      variant,
      patchPath,
      mutationContextPath,
      directory,
      directory,
    );
    assert.equal(bindingCalls, 2);
    assert.equal(bindingRepaired.result.variantId, variant.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compliance repair keeps the same hypothesis and receives immutable failed-attempt feedback', async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'planner-agent-repair-worktree-'));
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-agent-repair-artifacts-'));
  const mutationContextPath = path.join(artifacts, 'mutation-context.json');
  const treatmentPatchPath = path.join(artifacts, 'mutation.patch');
  const failedResultPath = path.join(artifacts, 'failed-result.json');
  await Promise.all([
    writeFile(mutationContextPath, '{"selectedFindings":[{"id":"finding-hydration"}]}\n'),
    writeFile(treatmentPatchPath, 'diff --git a/server/src/policy.ts b/server/src/policy.ts\n'),
    writeFile(
      failedResultPath,
      JSON.stringify({
        status: 'failed',
        intervention: { status: 'not_satisfied', rationale: 'Runtime clause is incomplete.' },
        codeRegression: { status: 'satisfied', rationale: 'Boundary test exists.' },
        falsificationTest: {
          status: 'deferred_to_evaluation',
          rationale: 'Coordinator-owned replay.',
        },
      }),
    ),
  ]);
  const calls: Array<{ args: string[]; cwd: string | undefined; attachments: string[] }> = [];
  const runner = new AgentRunner(
    campaign,
    async (command, args, options): Promise<CommandResult> => {
      const attachments = args.flatMap((value, index) =>
        value === '--file' ? [args[index + 1]!] : [],
      );
      calls.push({ args: [...args], cwd: options?.cwd, attachments });
      assert.equal(attachments.length, 3);
      assert.ok(attachments.every((value) => path.dirname(value) === worktree));
      return {
        command,
        args: [...args],
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      };
    },
  );
  const variant = {
    id: 'agent-repair-v001',
    hypothesis: {
      title: 'Retain evidence',
      rationale: 'Exercise the diagnosed mechanism.',
      instructions: 'Retain executable evidence.',
      expectedImpact: 'Better source-backed decisions.',
      risk: 'Over-admission.',
      findingIds: ['finding-hydration'],
    },
  } as VariantRecord;

  try {
    await runner.repairHypothesisCompliance(
      variant,
      worktree,
      artifacts,
      mutationContextPath,
      treatmentPatchPath,
      failedResultPath,
      2,
    );
    const prompt = calls[0]!.args.join(' ');
    assert.equal(calls[0]!.cwd, worktree);
    assert.match(prompt, /repair the existing mutation/i);
    assert.match(prompt, /same hypothesis/i);
    assert.match(prompt, /failed compliance checks/i);
    assert.match(prompt, /preserve.*satisfied/i);
    assert.match(prompt, /do not stage changes/i);
    assert.match(
      await readFile(
        path.join(artifacts, 'hypothesis-compliance', 'attempt-02', 'repair-prompt.txt'),
        'utf8',
      ),
      /Retain evidence/,
    );
    assert.ok(
      (await Promise.all(calls[0]!.attachments.map(async (value) => await stat(value).catch(() => null)))).every(
        (value) => value === null,
      ),
    );
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test('diagnostician archives strict cited unverified output and mutator receives bounded context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-agent-diagnosis-'));
  const inputPath = path.join(directory, 'diagnosis-input.json');
  const evidence = (id: string, summary: string) => ({
    id,
    kind: 'fixture',
    summary,
    affectedUnitKeys: ['unit-a'],
    provenance: {
      classification: 'observed_durable' as const,
      source: 'harness' as const,
      artifactPath: null,
      artifactSha256: null,
      integrity: 'verified' as const,
      caseId: 'case-a',
      runId: 'run-a',
      unitKey: 'unit-a',
      limitation: null,
    },
    data: { value: summary },
  });
  const diagnosisInput = DiagnosisInputSchema.parse({
    kind: 'ainative-planner-eval/diagnosis-input',
    schemaVersion: 1,
    interpretationPolicy: 'Diagnosis is model-generated, unverified, and excluded from numeric scoring.',
    campaign: {
      id: campaign.id,
      plannerSeed: campaign.seedSha,
      workflowsRevision: campaign.workflowsSha,
      environmentSha256: campaign.environmentSha,
      benchmarkPins: [],
    },
    variant: {
      id: 'agent-repair-v000',
      parentVariantId: null,
      round: 0,
      artifactCollectionComplete: true,
    },
    lineage: [],
    completeness: {
      status: 'complete',
      items: [
        {
          component: 'analysis',
          scope: 'primary',
          status: 'complete',
          captured: 1,
          expected: 1,
          limitations: [],
        },
      ],
      limitations: [],
    },
    evidence: [
      evidence('evidence-1111111111111111', 'support'),
      evidence('evidence-2222222222222222', 'counter'),
    ],
    reconstructionSignals: [],
  });
  const serializedInput = `${JSON.stringify(diagnosisInput, null, 2)}\n`;
  const inputSha256 = `sha256:${createHash('sha256').update(serializedInput).digest('hex')}`;
  await writeFile(inputPath, serializedInput);
  const calls: string[][] = [];
  const output = {
    kind: 'ainative-planner-eval/model-diagnosis',
    schemaVersion: 1,
    interpretationStatus: 'unverified_model_judgment',
    inputSha256,
    summary: 'Evidence may be lost after hydration.',
    findings: [
      {
        id: 'finding-hydration',
        category: 'evidence_hydration',
        affectedUnitKeys: ['unit-a'],
        causalMechanism: 'A qualified pointer did not survive admission.',
        supportingEvidenceRefs: ['evidence-1111111111111111'],
        counterEvidenceRefs: ['evidence-2222222222222222'],
        confidence: 'medium',
        genericIntervention: 'Retain executable hydrated evidence.',
        falsificationTest: 'Verify valid evidence is admitted while declarations remain rejected.',
        limitations: ['This is model inference.'],
        provenance: 'model_inference',
      },
    ],
    limitations: ['This is model inference.'],
  };
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: calls.length === 1 ? 'I am still inspecting the trace.' : JSON.stringify(output),
      stderr: '',
      durationMs: 1,
    };
  });
  try {
    const result = await runner.diagnose(inputPath, inputSha256, directory, directory);
    assert.equal(result.interpretationStatus, 'unverified_model_judgment');
    assert.equal(result.findings[0]?.id, 'finding-hydration');
    assert.match(calls[0]!.join(' '), /both supporting evidence and counterevidence/);
    assert.match(calls[0]!.join(' '), /excluded from numeric scoring|unverified/);
    assert.match(calls[0]!.join(' '), /research.*historical context only/i);
    assert.match(calls[0]!.join(' '), /not current-run evidence/i);
    assert.match(calls[1]!.join(' '), /previous response did not satisfy the required JSON contract/);
    assert.match(
      await readFile(
        path.join(directory, 'diagnosis', `diagnosis-result-${inputSha256.slice(7)}.json`),
        'utf8',
      ),
      /unverified_model_judgment/,
    );

    const contextPath = path.join(directory, 'mutation-context.json');
    await writeFile(contextPath, '{"selectedFindings":[]}\n');
    const variant = {
      id: 'agent-repair-v001',
      hypothesis: {
        title: 'Retain evidence',
        rationale: 'Cites the diagnosed mechanism.',
        instructions: 'Retain evidence.',
        expectedImpact: 'Better evidence-backed decisions.',
        risk: 'Over-admission.',
        findingIds: ['finding-hydration'],
      },
    } as VariantRecord;
    await runner.mutate(variant, directory, directory, contextPath);
    const mutatorCall = calls[2]!.join(' ');
    assert.match(mutatorCall, /harness-mutation-context/);
    assert.match(mutatorCall, /unverified model interpretation/);
    assert.doesNotMatch(mutatorCall, /raw log/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

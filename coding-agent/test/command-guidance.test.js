import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { openCodingApplication } from '@ismail-elkorchi/coding-agent';
import {
  createWorkspace,
  finalResponse,
  scriptedOllama,
  toolResponse,
  trust
} from './fixtures/scripted-cli.js';
import { withTestCodingEnvironment } from './fixtures/test-environment.js';

test(
  'nested repository guidance precedes command dispatch and the reconsidered command completes',
  {
    skip: process.platform !== 'linux',
    timeout: 30_000
  },
  async (t) => {
    const command = () =>
      toolResponse('exec_command', {
        command: 'printf inspected',
        workdir: 'subproject',
        yieldMs: 1_000
      });
    const provider = await scriptedOllama([
      command(),
      async (request) => {
        assert(
          request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.content.includes('context_required') &&
              message.content.includes('GUIDANCE-BEFORE-DISPATCH')
          )
        );
        const files = await readdir(fixture.stateRoot, { recursive: true });
        assert.equal(
          files.filter((file) => file.includes('/commands/') && file.endsWith('/state.json'))
            .length,
          0
        );
        return command();
      },
      (request) => {
        assert(request.messages.at(-1).content.includes('inspected'));
        return finalResponse('Inspection complete.');
      }
    ]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['exec_command'],
      checks: [],
      files: { 'subproject/AGENTS.md': 'GUIDANCE-BEFORE-DISPATCH: preserve unrelated files.\n' }
    });
    let application;
    t.after(async () => {
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication(
      withTestCodingEnvironment({
        root: fixture.root,
        stateRoot: fixture.stateRoot,
        providerEndpoint: provider.endpoint,
        permissionMode: 'develop'
      })
    );
    await application.start();
    const submitted = await application.submit({ task: 'Inspect the subproject.' });
    assert.equal(submitted.kind, 'started');
    const completed = await submitted.completion;
    assert.equal(completed.state, 'ended', JSON.stringify(completed));
    assert.equal(
      completed.terminal.executionStatus,
      'completed',
      JSON.stringify(completed.terminal)
    );
    const { history } = await application.readSession();
    const observations = history.entries.filter((entry) => entry.type === 'observation');
    assert.equal(observations.length, 2);
    assert.equal(observations[0].output.effectStarted, false);
    assert(['running', 'exited'].includes(observations[1].output.status));
    assert.match(observations[1].output.combined.text, /inspected/);
  }
);

// Source freshness is independent of provider success or an attempted prerequisite callback.
test(
  'guidance revisions require actual admitted delivery and detect additions, edits, removal and configured precedence',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { mkdtemp, mkdir, writeFile, rm, rename } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { RootedFileAuthority } = await import('@agent-core/tools-local');
    const { RepositoryGuidanceSession } = await import(
      '../dist/instructions/repository-guidance.js'
    );
    const { WorkspaceSecurityBoundary } = await import(
      '../dist/security/workspace-security-boundary.js'
    );
    const { identifyCodingWorkspace } = await import('../dist/security/workspace-identity.js');
    const directory = await mkdtemp(path.join(tmpdir(), 'guidance-revisions-'));
    const root = RootedFileAuthority.adopt(directory);
    t.after(async () => {
      root.close();
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'rules.md'), 'configured original');
    const security = new WorkspaceSecurityBoundary(
      identifyCodingWorkspace(root.identity),
      'trusted'
    );
    const guidance = RepositoryGuidanceSession.open({
      root,
      security,
      configuredPaths: ['rules.md']
    });
    const initial = await guidance.refresh();
    guidance.markRequestAdmitted({
      requestId: 'request-1',
      sourceIds: initial.instructions.map((item) => item.id)
    });
    const request = {
      call: { name: 'any-mutation' },
      input: {},
      effects: {
        accesses: [{ mode: 'write', scope: 'files/nested/file.txt' }],
        lockScopes: ['files/nested/file.txt']
      }
    };
    assert.equal(
      await guidance.contextPrerequisite(request),
      undefined,
      'Never-present guidance does not require a model round trip.'
    );
    await writeFile(path.join(directory, 'nested/AGENTS.md'), 'nested addition');
    let pending = await guidance.contextPrerequisite(request);
    assert(pending.context.some((item) => item.content.includes('nested addition')));
    guidance.markRequestAdmitted({
      requestId: 'request-3',
      sourceIds: pending.context.map((item) => item.id)
    });
    await writeFile(path.join(directory, 'nested/AGENTS.md'), 'changed during approval');
    pending = await guidance.contextPrerequisite(request);
    assert(pending.context.some((item) => item.content.includes('changed during approval')));
    assert.equal(await guidance.authorize(request), undefined);
    assert.deepEqual(
      await guidance.contextPrerequisite(request),
      pending,
      'authorization is not source delivery'
    );
    guidance.markRequestAdmitted({
      requestId: 'request-4',
      sourceIds: pending.context.map((item) => item.id)
    });
    await writeFile(path.join(directory, 'unrelated.txt'), 'unrelated change');
    assert.equal(await guidance.contextPrerequisite(request), undefined);
    await rename(
      path.join(directory, 'nested/AGENTS.md'),
      path.join(directory, 'nested/renamed.md')
    );
    pending = await guidance.contextPrerequisite(request);
    assert(
      pending.context.some((item) =>
        item.content.includes('Earlier content from this path is no longer applicable')
      )
    );
    guidance.markRequestAdmitted({
      requestId: 'request-5',
      sourceIds: pending.context.map((item) => item.id)
    });
    await writeFile(path.join(directory, 'AGENTS.md'), 'new root instructions');
    await writeFile(path.join(directory, 'rules.md'), 'new configured instructions');
    pending = await guidance.contextPrerequisite(request);
    assert(pending.context.some((item) => item.content.includes('new root instructions')));
    assert(pending.context.some((item) => item.content.includes('new configured instructions')));
    const refreshed = await guidance.refresh();
    assert(refreshed.instructions.some((item) => item.content.includes('new root instructions')));
    assert(
      refreshed.instructions.some((item) => item.content.includes('new configured instructions'))
    );
    const reopened = RepositoryGuidanceSession.open({
      root,
      security,
      configuredPaths: ['rules.md']
    });
    assert(
      (await reopened.refresh()).instructions.some((item) =>
        item.content.includes('new root instructions')
      )
    );
  }
);

test(
  'guidance targets use process effects rather than tool names; unsafe sources remain explicit',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { mkdtemp, mkdir, writeFile, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { RootedFileAuthority } = await import('@agent-core/tools-local');
    const { RepositoryGuidanceSession } = await import(
      '../dist/instructions/repository-guidance.js'
    );
    const { WorkspaceSecurityBoundary } = await import(
      '../dist/security/workspace-security-boundary.js'
    );
    const { identifyCodingWorkspace } = await import('../dist/security/workspace-identity.js');
    const directory = await mkdtemp(path.join(tmpdir(), 'guidance-process-'));
    const root = RootedFileAuthority.adopt(directory);
    t.after(async () => {
      root.close();
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'nested/AGENTS.md'), 'process scoped instructions');
    const guidance = RepositoryGuidanceSession.open({
      root,
      security: new WorkspaceSecurityBoundary(identifyCodingWorkspace(root.identity), 'trusted')
    });
    const request = {
      call: { name: 'custom-command' },
      input: { workdir: 'nested' },
      effects: { accesses: [{ mode: 'execute', scope: 'processes' }], lockScopes: ['files'] }
    };
    const pending = await guidance.contextPrerequisite(request);
    assert(pending.context.some((item) => item.content.includes('process scoped instructions')));
    await rm(path.join(directory, 'nested/AGENTS.md'));
    await symlink('../outside.md', path.join(directory, 'nested/AGENTS.md'));
    assert.equal((await guidance.authorize(request)).decision, 'deny');
    assert(
      (await guidance.contextPrerequisite(request)).context.some((item) =>
        item.content.includes('unavailable')
      )
    );
  }
);

test(
  'root guidance refreshes between runs in one open application',
  { skip: process.platform !== 'linux', timeout: 30000 },
  async (t) => {
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const provider = await scriptedOllama([
      (request) => {
        assert.match(JSON.stringify(request.messages), /ROOT-FIRST-REVISION/u);
        return finalResponse('First response.');
      },
      (request) => {
        assert.match(JSON.stringify(request.messages), /ROOT-SECOND-REVISION/u);
        return finalResponse('Second response.');
      }
    ]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files'],
      checks: [],
      files: { 'AGENTS.md': 'ROOT-FIRST-REVISION' }
    });
    let application;
    t.after(async () => {
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication(
      withTestCodingEnvironment({
        root: fixture.root,
        stateRoot: fixture.stateRoot,
        providerEndpoint: provider.endpoint
      })
    );
    await application.start();
    const first = await application.submit({ task: 'First request.' });
    await first.completion;
    await writeFile(path.join(fixture.root, 'AGENTS.md'), 'ROOT-SECOND-REVISION');
    const second = await application.submit({ task: 'Second request.' });
    assert.equal((await second.completion).state, 'ended');
  }
);

test(
  'guidance changed during approval defers the old patch before any effect',
  { skip: process.platform !== 'linux', timeout: 30000 },
  async (t) => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const original = 'original\n';
    const provider = await scriptedOllama([
      toolResponse('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: file.txt\n@@\n-original\n+changed\n*** End Patch',
        expectedOldSha256: { 'file.txt': createHash('sha256').update(original).digest('hex') }
      }),
      async (request) => {
        assert.match(JSON.stringify(request.messages), /GUIDANCE-CHANGED-DURING-APPROVAL/u);
        assert.equal(await readFile(path.join(fixture.root, 'file.txt'), 'utf8'), original);
        return finalResponse('The guidance changed. The earlier patch did not execute.');
      }
    ]);
    const fixture = await createWorkspace({
      endpoint: provider.endpoint,
      tools: ['read_files', 'apply_patch'],
      checks: [],
      requireApprovalFor: ['write'],
      files: { 'file.txt': original, 'AGENTS.md': 'Initial instructions.' }
    });
    let application;
    t.after(async () => {
      await application?.close();
      await provider.close();
      await fixture.close();
    });
    await trust(fixture);
    application = await openCodingApplication(
      withTestCodingEnvironment({
        root: fixture.root,
        stateRoot: fixture.stateRoot,
        providerEndpoint: provider.endpoint,
        permissionMode: 'edit'
      })
    );
    await application.start();
    const submitted = await application.submit({ task: 'Apply the patch.' });
    const suspended = await submitted.completion;
    assert.equal(suspended.state, 'suspended');
    const approval = suspended.pendingApprovals[0];
    assert(approval);
    await writeFile(path.join(fixture.root, 'AGENTS.md'), 'GUIDANCE-CHANGED-DURING-APPROVAL');
    const resolved = await application.resolveApproval({
      runId: submitted.runId,
      approvalId: approval.approvalId,
      fingerprint: approval.fingerprint,
      decision: 'allow'
    });
    assert.equal(resolved.state, 'ended');
    assert.equal(await readFile(path.join(fixture.root, 'file.txt'), 'utf8'), original);
  }
);

test(
  'configured guidance order is a source dependency even when file contents match',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { RootedFileAuthority } = await import('@agent-core/tools-local');
    const { RepositoryGuidanceSession } = await import(
      '../dist/instructions/repository-guidance.js'
    );
    const { WorkspaceSecurityBoundary } = await import(
      '../dist/security/workspace-security-boundary.js'
    );
    const { identifyCodingWorkspace } = await import('../dist/security/workspace-identity.js');
    const directory = await mkdtemp(path.join(tmpdir(), 'guidance-precedence-'));
    const root = RootedFileAuthority.adopt(directory);
    t.after(async () => {
      root.close();
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(path.join(directory, 'first.md'), 'identical');
    await writeFile(path.join(directory, 'second.md'), 'identical');
    const security = new WorkspaceSecurityBoundary(
      identifyCodingWorkspace(root.identity),
      'trusted'
    );
    const first = await RepositoryGuidanceSession.open({
      root,
      security,
      configuredPaths: ['first.md', 'second.md']
    }).refresh();
    const second = await RepositoryGuidanceSession.open({
      root,
      security,
      configuredPaths: ['second.md', 'first.md']
    }).refresh();
    assert.notDeepEqual(
      first.instructions.map((item) => item.id),
      second.instructions.map((item) => item.id)
    );
    assert(
      first.sources.find((item) => item.path === 'first.md').precedence <
        first.sources.find((item) => item.path === 'second.md').precedence
    );
    assert(
      second.sources.find((item) => item.path === 'first.md').precedence >
        second.sources.find((item) => item.path === 'second.md').precedence
    );
  }
);

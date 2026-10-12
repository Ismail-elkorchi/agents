import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlSessionRepository, SessionHistorySourceError } from '@agent-core/runtime/node';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { openCodingApplication, openCodingWorkspace, codingWorkspaceSessionBinding } from '@ismail-elkorchi/coding-agent';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';

const integration = { skip: process.platform !== 'linux' };

async function fixture(t, agent) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), `${agent}-history-maintenance-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const stateRoot = path.join(parent, 'state');
  await fs.mkdir(root);
  let sessionsDir;
  let binding;
  if (agent === 'coding-agent') {
    const workspace = await openCodingWorkspace(root, { stateRoot });
    sessionsDir = workspace.layout.sessionsDir;
    binding = codingWorkspaceSessionBinding(workspace.layout.identity);
    workspace.fileRoot.close();
  } else {
    const application = await openWritingApplication({ rootDirectory: root, stateRoot });
    sessionsDir = path.join(path.dirname(application.presentationPath()), 'sessions');
    await application.close();
    const workspace = RootedFileAuthority.adopt(root);
    const { device, inode, mountId } = workspace.identity;
    binding = { schemaId: 'writing-agent/workspace', schemaVersion: 1, subject: { device, inode, mountId } };
    workspace.close();
  }
  const repository = new JsonlSessionRepository(sessionsDir);
  const session = await repository.create({ id: 'needs-recovery', binding });
  await repository.appendInput(session, { runId: 'original-run', task: 'Preserve this original.' });
  const healthy = await repository.create({ id: 'healthy', binding });
  await repository.appendInput(healthy, { runId: 'other-run', task: 'Keep this session intact.' });
  const file = repository.location(session.id);
  const index = `${file}.index`;
  const open = (selected = false, options = {}) => agent === 'coding-agent'
    ? openCodingApplication({ root, stateRoot, ...(selected ? { sessionSelection: { kind: 'existing', id: session.id } } : {}), ...options })
    : openWritingApplication({ rootDirectory: root, stateRoot, ...(selected ? { sessionId: session.id } : {}), ...options });
  return { root, stateRoot, sessionsDir, repository, session, healthy, file, index, open };
}

function run(agent, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(`${agent}/dist/cli.js`), ...args], {
      env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function observe(application) {
  const progress = [];
  application.subscribe(event => {
    if (event.type === 'history.recovery') progress.push(event.progress);
  }, error => assert.fail(error));
  return progress;
}

for (const agent of ['coding-agent', 'writing-agent']) {
  for (const damage of ['missing', 'damaged']) {
    test(`${agent} automatically restores a ${damage} index at startup before configuration`, integration, async t => {
      const f = await fixture(t, agent);
      const original = await fs.readFile(f.file);
      const healthyIndex = `${f.repository.location(f.healthy.id)}.index`;
      const healthyBytes = await fs.readFile(healthyIndex);
      const healthyStat = await fs.stat(healthyIndex);
      if (damage === 'missing') await fs.unlink(f.index);
      else await fs.writeFile(f.index, 'damaged derived metadata\n');
      const application = await f.open(agent === 'coding-agent');
      t.after(() => application.close());
      const progress = observe(application);
      await application.start();
      assert.equal(application.state().status, agent === 'coding-agent' ? 'setup_required' : 'configuration_required');
      assert.deepEqual(progress.filter(value => value.phase !== 'progress').map(value => value.phase), ['started', 'completed']);
      assert(progress.some(value => value.phase === 'progress' && value.records > 0 && value.bytes > 0));
      assert(progress.every(value => value.sessionId === f.session.id));
      assert.deepEqual(await fs.readFile(f.file), original);
      assert.deepEqual(await fs.readFile(healthyIndex), healthyBytes);
      assert.equal((await fs.stat(healthyIndex)).mtimeMs, healthyStat.mtimeMs);
      assert.equal((await new JsonlSessionRepository(f.sessionsDir).list()).length, 2);
      await application.start();
      assert.equal(progress.filter(value => value.phase === 'started').length, 1);
    });
  }

  test(`${agent} explicit startup selection only recovers the selected session`, integration, async t => {
    const f = await fixture(t, agent);
    await fs.writeFile(f.index, 'selected broken index\n');
    const otherIndex = `${f.repository.location(f.healthy.id)}.index`;
    await fs.writeFile(otherIndex, 'unselected broken index\n');
    const application = await f.open(true);
    t.after(() => application.close());
    const progress = observe(application);
    await application.start();
    assert(progress.every(value => value.sessionId === f.session.id));
    assert.equal(await fs.readFile(otherIndex, 'utf8'), 'unselected broken index\n');
    assert.equal((await new JsonlSessionRepository(f.sessionsDir).readBranchPage(f.session)).entries.length, 1);
  });

  test(`${agent} session listing preflights new index damage without activating a model`, integration, async t => {
    const f = await fixture(t, agent);
    const application = await f.open();
    t.after(() => application.close());
    await application.start();
    const original = await fs.readFile(f.file);
    await fs.writeFile(f.index, 'damaged after startup\n');
    const progress = observe(application);
    assert.equal((await application.listSessions()).length, 2);
    assert.equal(progress.filter(value => value.phase === 'completed').length, 1);
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.equal((await application.listSessions()).length, 2);
    assert.equal(progress.filter(value => value.phase === 'started').length, 1);
  });

  test(`${agent} ordinary abort cancels automatic recovery without publishing or retrying`, integration, async t => {
    const f = await fixture(t, agent);
    await fs.writeFile(f.index, 'old index remains on cancellation\n');
    const oldIndex = await fs.readFile(f.index);
    const original = await fs.readFile(f.file);
    const application = await f.open(true);
    t.after(() => application.close());
    const progress = observe(application);
    application.subscribe(event => {
      if (event.type === 'history.recovery' && event.progress.phase === 'progress' && event.progress.records >= 1)
        void application.abort();
    }, error => assert.fail(error));
    await assert.rejects(application.start(), error => error.name === 'AbortError');
    assert.deepEqual(progress.filter(value => value.phase !== 'progress').map(value => value.phase), ['started', 'cancelled']);
    assert(progress.some(value => value.phase === 'progress' && value.records >= 1));
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.deepEqual(await fs.readFile(f.index), oldIndex);
    assert.equal(application.state().session, undefined);
  });

  for (const destination of ['new', 'healthy']) {
    test(`${agent} ordinary navigation to ${destination} cancels opening and retains the destination`, integration, async t => {
      const f = await fixture(t, agent);
      await fs.writeFile(f.index, 'old index remains on navigation\n');
      const original = await fs.readFile(f.file);
      const application = await f.open(true);
      t.after(() => application.close());
      const progress = observe(application);
      let navigation;
      application.subscribe(event => {
        if (event.type === 'history.recovery' && event.progress.phase === 'started')
          navigation = destination === 'new' ? application.newSession() : application.selectSession(f.healthy.id);
      }, error => assert.fail(error));
      await assert.rejects(application.start(), error => error.name === 'AbortError');
      await navigation;
      await application.start();
      assert.deepEqual(progress.filter(value => value.phase !== 'progress').map(value => value.phase), ['started', 'cancelled']);
      assert.equal(await fs.readFile(f.index, 'utf8'), 'old index remains on navigation\n');
      assert.deepEqual(await fs.readFile(f.file), original);
      if (agent === 'writing-agent') {
        if (destination === 'healthy') assert.equal(application.state().sessionId, f.healthy.id);
        else assert.notEqual(application.state().sessionId, f.session.id);
      }
      assert.equal(application.state().status, agent === 'coding-agent' ? 'setup_required' : 'configuration_required');
    });
  }

  test(`${agent} closing during recovery cancels before resource teardown`, integration, async t => {
    const f = await fixture(t, agent);
    await fs.writeFile(f.index, 'old index remains on close\n');
    const application = await f.open(true);
    let closing;
    application.subscribe(event => {
      if (event.type === 'history.recovery' && event.progress.phase === 'started')
        closing = application.close();
    }, error => assert.fail(error));
    await assert.rejects(application.start(), error => error.name === 'AbortError');
    await closing;
    assert.equal(await fs.readFile(f.index, 'utf8'), 'old index remains on close\n');
    await assert.rejects(async () => application.start(), /closed/u);
  });

  test(`${agent} source corruption stops automatic recovery once and leaves originals intact`, integration, async t => {
    const f = await fixture(t, agent);
    const oldIndex = await fs.readFile(f.index);
    await fs.appendFile(f.file, '{invalid original}\n');
    const original = await fs.readFile(f.file);
    const application = await f.open(true);
    t.after(() => application.close());
    const progress = observe(application);
    await assert.rejects(application.start(), error => error instanceof SessionHistorySourceError);
    assert.deepEqual(progress.filter(value => value.phase !== 'progress').map(value => value.phase), ['started', 'failed']);
    assert.match(progress.at(-1).message, /saved messages couldn’t be read/u);
    assert.equal(progress.filter(value => value.phase === 'started').length, 1);
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.deepEqual(await fs.readFile(f.index), oldIndex);
    assert.equal(application.state().session, undefined);
  });

  test(`${agent} CLI startup restores indexes without credentials or a repair command`, integration, async t => {
    const f = await fixture(t, agent);
    await fs.unlink(f.index);
    const result = await run(agent, [
      ...(agent === 'coding-agent' ? ['exec', '--session', f.session.id] : ['write', 'continue', '--session', f.session.id]),
      '--root', f.root, '--state-root', f.stateRoot
    ], {
      OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', CODING_AGENT_PROVIDER: '', CODING_AGENT_MODEL: '',
      WRITING_AGENT_PROVIDER: undefined, WRITING_AGENT_MODEL: undefined, HOME: path.join(f.root, 'no-credentials-here')
    });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /history index|restoring|recovery|needs-recovery|\d+ records|\d+ bytes/iu);
    assert.doesNotMatch(result.stderr, /history-repair/u);
    assert.equal((await new JsonlSessionRepository(f.sessionsDir).list()).length, 2);
    const help = await run(agent, ['--help']);
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.stdout, /history-repair/u);
  });
}

test('writing provider construction is deferred until automatic history recovery finishes', integration, async t => {
  const f = await fixture(t, 'writing-agent');
  await fs.unlink(f.index);
  const application = await f.open(true, { modelSelection: { provider: 'unsupported-provider', model: 'unused' } });
  t.after(() => application.close());
  const progress = observe(application);
  await assert.rejects(application.start(), /Unsupported writing provider/u);
  assert.equal(progress.at(-1).phase, 'completed');
  assert.equal((await new JsonlSessionRepository(f.sessionsDir).list()).length, 2);
});

test('corrupt writing history fails before any configured provider or model activation', integration, async t => {
  const f = await fixture(t, 'writing-agent');
  await fs.appendFile(f.file, '{invalid original}\n');
  let activations = 0;
  const application = await f.open(true, {
    configuration: {
      model: 'unused',
      provider: {
        id: 'never-activated', implementationId: 'never-activated@1',
        describeModel() { activations++; throw new Error('Provider must not be activated.'); }
      }
    }
  });
  t.after(() => application.close());
  await assert.rejects(application.start(), error => error instanceof SessionHistorySourceError);
  assert.equal(activations, 0);
});

for (const agent of ['coding-agent', 'writing-agent']) {
  test(`${agent} default history selection isolates an invalid unrelated session and retains its diagnostic`, integration, async t => {
    const f = await fixture(t, agent);
    const validOriginal = await fs.readFile(f.file);
    await fs.appendFile(f.file, '{invalid original}\n');
    const invalidOriginal = await fs.readFile(f.file);
    const application = await f.open(false, agent === 'coding-agent' ? { sessionSelection: { kind: 'latest' } } : {});
    t.after(() => application.close());
    const progress = observe(application);
    await application.start();
    assert.equal(application.state().status, agent === 'coding-agent' ? 'setup_required' : 'configuration_required');
    assert.match(application.state().historyRecoveryFailures[f.session.id], /saved messages couldn’t be read/u);
    assert.deepEqual((await application.listSessions()).map(session => session.id), [f.healthy.id]);
    assert.deepEqual(Object.keys(application.state().historyRecoveryFailures), [f.session.id]);
    assert.deepEqual(await fs.readFile(f.file), invalidOriginal);
    assert(progress.some(event => event.phase === 'failed' && event.sessionId === f.session.id));
    // Simulate an explicit external restoration of the original. A successful later listing clears its stale diagnostic.
    await fs.writeFile(f.file, validOriginal);
    assert.equal((await application.listSessions()).length, 2);
    assert.equal(application.state().historyRecoveryFailures, undefined);
  });

  test(`${agent} explicitly selecting a healthy session does not scan an unrelated invalid original`, integration, async t => {
    const f = await fixture(t, agent);
    await fs.appendFile(f.file, '{invalid original}\n');
    const invalidOriginal = await fs.readFile(f.file);
    const application = await f.open(false, agent === 'coding-agent'
      ? { sessionSelection: { kind: 'existing', id: f.healthy.id } }
      : { sessionId: f.healthy.id });
    t.after(() => application.close());
    const progress = observe(application);
    await application.start();
    assert.deepEqual(progress, []);
    assert.equal(application.state().historyRecoveryFailures, undefined);
    assert.deepEqual(await fs.readFile(f.file), invalidOriginal);
  });
}

test('a new coding session does not scan unrelated history before startup', integration, async t => {
  const f = await fixture(t, 'coding-agent');
  await fs.appendFile(f.file, '{invalid original}\n');
  const application = await f.open();
  t.after(() => application.close());
  const progress = observe(application);
  await application.start();
  assert.equal(application.state().status, 'setup_required');
  assert.deepEqual(progress, []);
  assert.equal(application.state().historyRecoveryFailures, undefined);
  assert.deepEqual((await application.listSessions()).map(session => session.id), [f.healthy.id]);
  assert.match(application.state().historyRecoveryFailures[f.session.id], /saved messages couldn’t be read/u);
});

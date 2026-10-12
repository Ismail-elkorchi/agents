import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { JsonlSessionRepository, SessionHistoryIndexError } from '@agent-core/runtime/node';
import { RootedFileAuthority } from '@agent-core/tools-local';
import { HistoryRecoveryProgressRenderer } from '@agent-core/tui';
import { openCodingApplication, openCodingWorkspace, codingWorkspaceSessionBinding } from '@ismail-elkorchi/coding-agent';
import { openWritingApplication } from '@ismail-elkorchi/writing-agent';

for (const agent of ['coding', 'writing']) {
  for (const failure of ['staged-open', 'staged-sync', 'rename', 'lock-timeout']) {
    test(`${agent} keeps ${failure} opening details internal while reporting the real failure`, {
      skip: process.platform !== 'linux', timeout: 15_000
    }, async t => {
      const f = await fixture(t, agent);
      const original = await fs.readFile(f.file);
      await fs.writeFile(f.index, 'damaged metadata\n');
      const previousIndex = await fs.readFile(f.index);
      let injected;
      const failureFor = target => {
        injected = Object.assign(new Error(`EIO: injected ${failure} for ${target}`), {
          code: 'EIO', path: target, syscall: failure
        });
        return injected;
      };
      if (failure === 'staged-open' || failure === 'staged-sync') {
        const open = fs.open;
        t.mock.method(fs, 'open', async function(target, flags, ...args) {
          const staged = typeof target === 'string' &&
            path.dirname(target) === path.dirname(f.index) &&
            path.basename(target).startsWith(`.${path.basename(f.index)}.`) && target.endsWith('.tmp');
          if (staged && failure === 'staged-open') throw failureFor(target);
          const handle = await open.call(this, target, flags, ...args);
          if (staged) t.mock.method(handle, 'sync', async () => { throw failureFor(target); });
          return handle;
        });
      } else if (failure === 'rename') {
        const rename = fs.rename;
        t.mock.method(fs, 'rename', async function(from, to) {
          if (to === f.index) throw failureFor(from);
          return rename.call(this, from, to);
        });
      } else {
        const lock = `${f.index}.lock`;
        await fs.mkdir(lock);
        await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'other-owner' }));
        const now = Date.now();
        let ticks = 0;
        // Spend the real lock acquisition deadline without a slow wall-clock test.
        t.mock.method(Date, 'now', () => now + ticks++ * 10_000);
      }
      const messages = [];
      const diagnostics = [];
      const renderer = new HistoryRecoveryProgressRenderer(message => messages.push(message));
      const unsubscribe = f.application.subscribe(event => {
        if (event.type !== 'history.recovery') return;
        renderer.handle(event.progress);
        if (event.progress.phase === 'failed') diagnostics.push(event.progress.message);
      }, error => assert.fail(error));
      try {
        await assert.rejects(f.application.start(), error => {
          assert(error instanceof SessionHistoryIndexError);
          assert.equal(error.sessionId, 'selected');
          assert.equal(error.message, 'This conversation couldn’t be opened. Please try again.');
          assert.doesNotMatch(error.message, /index|recovery|persistence|\.tmp|EIO/iu);
          if (failure === 'lock-timeout') {
            assert.match(error.cause.cause.message, /Timed out acquiring persistence lock/u);
            assert.match(error.cause.cause.message, /selected.*index\.lock/u);
            assert.equal(error.cause.cause.cause.code, 'EEXIST');
          } else {
            assert.equal(error.cause.cause, injected);
            assert.equal(error.cause.cause.code, 'EIO');
            assert.match(error.cause.cause.path, /\.index\..*\.tmp$/u);
          }
          return true;
        });
        await setImmediate();
        assert.equal(diagnostics.length, 1);
        assert.match(diagnostics[0], failure === 'lock-timeout' ? /persistence lock/u : /injected/u);
        assert.ok(messages.every(message => message === 'Opening conversation…'));
        assert.deepEqual(await fs.readFile(f.file), original);
        assert.deepEqual(await fs.readFile(f.index), previousIndex);
      } finally {
        unsubscribe();
        t.mock.restoreAll();
        await f.application.close();
      }
    });
  }
  test(`${agent} reports directory access failure without inventing a conversation ID`, {
    skip: process.platform !== 'linux', timeout: 15_000
  }, async t => {
    const f = await fixture(t, agent, false);
    const original = await fs.readFile(f.file);
    const raw = Object.assign(new Error(`EACCES: permission denied, scandir '${f.sessions}'`), {
      code: 'EACCES', path: f.sessions, syscall: 'scandir'
    });
    const readdir = fs.readdir;
    t.mock.method(fs, 'readdir', async function(target, ...args) {
      if (target === f.sessions) throw raw;
      return readdir.call(this, target, ...args);
    });
    try {
      await assert.rejects(f.application.start(), error => {
        assert(error instanceof SessionHistoryIndexError);
        assert.equal(error.sessionId, undefined);
        assert.equal(error.message, 'This conversation couldn’t be opened. Please try again.');
        assert.equal(error.cause.cause, raw);
        assert.equal(error.cause.cause.code, 'EACCES');
        assert.equal(error.cause.cause.path, f.sessions);
        assert.doesNotMatch(error.message, /index|recovery|EACCES|scandir|sessions/iu);
        return true;
      });
      assert.deepEqual(await fs.readFile(f.file), original);
    } finally {
      t.mock.restoreAll();
      await f.application.close();
    }
  });

}

async function fixture(t, agent, selected = true) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'conversation-opening-io-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace');
  const stateRoot = path.join(directory, 'state');
  await fs.mkdir(root);
  let sessions;
  let binding;
  if (agent === 'coding') {
    const workspace = await openCodingWorkspace(root, { stateRoot });
    sessions = workspace.layout.sessionsDir;
    binding = codingWorkspaceSessionBinding(workspace.layout.identity);
    workspace.fileRoot.close();
  } else {
    const application = await openWritingApplication({ rootDirectory: root, stateRoot });
    sessions = path.join(path.dirname(application.presentationPath()), 'sessions');
    await application.close();
    const authority = RootedFileAuthority.adopt(root);
    const { device, inode, mountId } = authority.identity;
    binding = { schemaId: 'writing-agent/workspace', schemaVersion: 1, subject: { device, inode, mountId } };
    authority.close();
  }
  const repository = new JsonlSessionRepository(sessions);
  const session = await repository.create({ id: 'selected', binding });
  await repository.appendInput(session, { runId: 'original', task: 'Keep the original conversation.' });
  const file = repository.location(session.id);
  const application = agent === 'coding'
    ? await openCodingApplication({ root, stateRoot, sessionSelection: selected ? { kind: 'existing', id: session.id } : { kind: 'latest' } })
    : await openWritingApplication({ rootDirectory: root, stateRoot, ...(selected ? { sessionId: session.id } : {}) });
  return { file, index: `${file}.index`, sessions, application };
}

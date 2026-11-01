import test from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { spawn } from 'child_process';
import type { AddressInfo } from 'net';

// Detached task runs (docs/specs/detached-runner.md). Each test file under
// `node --test` runs in its own process, so — like smoke.test.ts — the data dir
// and the fake agent binary are set before any server module is required.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-detached-test-'));
process.env.PLOYD_DATA_DIR = path.join(ROOT, 'data');
const REPO = path.join(ROOT, 'repo');
fs.mkdirSync(REPO, { recursive: true });

// A fake `claude`: reads its prompt from stdin and prints stream-json lines.
// What it does is chosen by a `MODE:<x>` word in the prompt:
//   quick         init, a text line, a result
//   noresult      init, then exit 3 without a result
//   wait:<file>   init, then wait for <file> to exist before the result
//   group:<file>  init, start a `sleep` grandchild, write its pid to <file>, wait forever
const FAKE = path.join(ROOT, 'fake-claude.js');
fs.writeFileSync(FAKE, `#!${process.execPath}
const fs = require('fs');
const { spawn } = require('child_process');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const mode = (input.match(/MODE:(\\S+)/) || [])[1] || 'quick';
  out({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid, model: 'fake-model' });
  process.stderr.write('fake stderr line\\n');
  if (mode === 'noresult') process.exit(3);
  if (mode.startsWith('wait:')) { while (!fs.existsSync(mode.slice(5))) await sleep(30); }
  if (mode.startsWith('group:')) {
    const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(mode.slice(6), String(kid.pid));
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 1, duration_ms: 5, result: 'got: ' + input.trim() });
});
`, { mode: 0o755 });
process.env.CLAUDE_BIN = FAKE;

const spawned: number[] = [];

test.after(() => {
  // Never leave a fake agent behind, then drop the scratch tree.
  for (const pid of spawned) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function mkTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, title: id, prompt: 'do it', repoId: 'repoA', repoName: 'R', repoPath: REPO, agent: 'claude',
    addons: [], personas: [], attachments: [], autoCodeReview: false, useWorktree: false, worktreePath: null,
    branchName: null, baseBranch: null, branch: null, model: 'default', permissionMode: 'acceptEdits',
    allowedTools: '', promptPermissions: false, status: 'ready', sessionId: null, resolvedModel: null,
    costUsd: 0, numTurns: null, durationMs: null, modelUsage: {}, runCount: 0, activeSubagents: 0,
    lastOutcome: null, lastError: null, archived: false, createdAt: '', updatedAt: '',
    startedAt: null, finishedAt: null, resolvingConflicts: false, ...extra,
  };
}

// Put `tasks` on the shared store with detached runs on (or off) and memory
// distillation off (it would spawn another fake session), and return a cleanup.
function withStore(tasks: unknown[], detachedRuns = true) {
  const store = require('../server/store');
  const prev = { tasks: store.db.tasks, settings: { ...store.db.settings } };
  store.db.tasks = tasks;
  store.db.settings.detachedRuns = detachedRuns;
  store.db.settings.memory = false;
  store.db.settings.maxParallelSessions = 10;
  return () => {
    store.db.tasks = prev.tasks;
    store.db.settings = Object.assign(store.db.settings, prev.settings);
  };
}

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function logOf(taskId: string): { type: string; text?: string; subtype?: string }[] {
  return require('../server/store').readLog(taskId);
}

function runDirs(): string[] {
  const store = require('../server/store');
  try { return fs.readdirSync(store.RUNS_DIR); } catch { return []; }
}

// Start the fake agent exactly as a detached run would, as if a previous server
// had, and write its record. Returns the record.
function spawnDetached(taskId: string, prompt: string, extra: Record<string, unknown> = {}) {
  const detached = require('../server/detached');
  const dir = detached.runDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  const stdinPath = path.join(dir, 'prompt.txt');
  const stdoutPath = path.join(dir, 'stdout.ndjson');
  const stderrPath = path.join(dir, 'stderr.log');
  fs.writeFileSync(stdinPath, prompt);
  const inFd = fs.openSync(stdinPath, 'r');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  const child = spawn(FAKE, [], { cwd: REPO, stdio: [inFd, outFd, errFd], detached: true });
  fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
  child.unref();
  spawned.push(child.pid!);
  const rec = {
    taskId, kind: 'dispatch', agent: 'claude', pid: child.pid, startTime: detached.processStartTime(child.pid),
    dir, stdinPath, stdoutPath, stderrPath, offset: 0, errOffset: 0, tempFiles: [], stopped: false,
    startedAt: new Date().toISOString(), ...extra,
  };
  detached.writeRecord(rec);
  return { rec, child };
}

function exited(child: import('child_process').ChildProcess): Promise<void> {
  return new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())));
}

test('detached: liveness needs the pid AND its start time to match', async () => {
  const detached = require('../server/detached');
  const mine = detached.processStartTime(process.pid);
  assert.ok(mine, 'ps reports a start time for a live process');
  assert.strictEqual(detached.isAlive(process.pid, mine), true, 'same pid, same start time → alive');
  assert.strictEqual(detached.isAlive(process.pid, 'Mon Jan  1 00:00:00 1990'), false, 'a reused pid (other start time) is not our run');
  assert.strictEqual(detached.isAlive(process.pid, null), false, 'no start time on record → treated as gone');

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const started = detached.processStartTime(child.pid);
  await exited(child);
  assert.strictEqual(detached.pidExists(child.pid), false, 'an exited (and reaped) process does not exist');
  assert.strictEqual(detached.isAlive(child.pid, started), false, 'an exited process is not alive');
  assert.strictEqual(detached.processStartTime(child.pid), null, 'no start time for a gone pid');
});

test('detached: readLines tails from an offset, never re-reads a line, and holds back a partial one', () => {
  const detached = require('../server/detached');
  const file = path.join(ROOT, 'tail.ndjson');
  fs.writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":');

  const first = detached.readLines(file, 0);
  assert.deepStrictEqual(first.lines, ['{"a":1}', '{"b":2}'], 'only complete lines are returned');
  assert.strictEqual(first.offset, Buffer.byteLength('{"a":1}\n{"b":2}\n'), 'the offset stops after the last newline');

  assert.deepStrictEqual(detached.readLines(file, first.offset).lines, [], 'a partial line waits for its newline');

  fs.appendFileSync(file, '3}\n{"d":"é"}\n');
  const second = detached.readLines(file, first.offset);
  assert.deepStrictEqual(second.lines, ['{"c":3}', '{"d":"é"}'], 'the rest arrives once, multi-byte text intact');
  assert.deepStrictEqual(detached.readLines(file, second.offset).lines, [], 'nothing is read twice');

  fs.appendFileSync(file, '{"e":5}');
  const last = detached.readLines(file, second.offset, true);
  assert.deepStrictEqual(last.lines, ['{"e":5}'], 'a final read takes the unterminated last line');
  assert.strictEqual(last.offset, fs.statSync(file).size);

  assert.deepStrictEqual(detached.readHandled(file, second.offset), ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":"é"}'],
    'readHandled returns exactly the lines before the offset');
});

test('detached: a detached dispatch runs from files, finishes like a normal run, and cleans up', async () => {
  const runner = require('../server/runner');
  const task = mkTask('det-quick');
  const restore = withStore([task]);
  try {
    runner.dispatch(task, 'MODE:quick hello');
    const live = runner.liveChildren().find((c: { id: string }) => c.id === task.id);
    assert.ok(live && live.pid, 'the run is in the live pool with its pid');
    spawned.push(live.pid);
    assert.strictEqual(runDirs().length, 1, 'a run folder is written while it is live');

    await until(() => task.status !== 'running', 'the run to finish');
    assert.strictEqual(task.status, 'validation', 'a result event lands the task in validation');
    assert.strictEqual(task.lastOutcome, 'success');
    assert.strictEqual(task.sessionId, `sess-${live.pid}`, 'the session id comes from the stream');
    assert.strictEqual(task.costUsd, 0.01, 'the result is billed once');
    assert.strictEqual(runner.isRunning(task.id), false);
    assert.deepStrictEqual(runDirs(), [], 'the run folder is removed once the run is settled');

    const log = logOf(task.id);
    const result = log.filter((e) => e.type === 'result');
    assert.strictEqual(result.length, 1, 'each stream line is logged exactly once');
    assert.match(JSON.stringify(result[0]), /got: MODE:quick hello/, 'the prompt reached the child through its stdin file');
    assert.ok(log.some((e) => e.type === 'stderr' && e.text === 'fake stderr line'), 'stderr is tailed into the log');
    assert.ok(log.some((e) => e.type === 'proc' && e.text === 'Run finished (exit 0)'), 'the attached path still knows the exit code');
  } finally {
    restore();
  }
});

test('detached: setting off = the old attached spawn (pipes, no detached group, no run folder)', () => {
  const runner = require('../server/runner');
  const cp = require('child_process');
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');
  const real = cp.spawn;
  const calls: { options: { stdio: unknown; detached?: boolean }; child: any }[] = [];
  cp.spawn = (_bin: string, _args: string[], options: { stdio: unknown; detached?: boolean }) => {
    const child = new EventEmitter() as any;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.stdin = { on() {}, write() {}, end() {} };
    child.kill = () => {};
    calls.push({ options, child });
    return child;
  };
  const task = mkTask('det-off');
  const restore = withStore([task], false);
  try {
    runner.dispatch(task, 'MODE:quick');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'], 'stdio stays three pipes');
    assert.ok(!calls[0].options.detached, 'no detached process group');
    assert.deepStrictEqual(runDirs(), [], 'no run record is written');
  } finally {
    cp.spawn = real;
    if (calls[0]) calls[0].child.emit('exit', 0, null);
    restore();
  }
});

test('detached: a live run survives a shutdown and is reattached from its saved offset', async () => {
  const runner = require('../server/runner');
  const detached = require('../server/detached');
  const gate = path.join(ROOT, 'gate-reattach');
  const task = mkTask('det-live');
  const restore = withStore([task]);
  try {
    runner.dispatch(task, `MODE:wait:${gate}`);
    const pid = runner.liveChildren().find((c: { id: string }) => c.id === task.id).pid;
    spawned.push(pid);
    await until(() => !!task.sessionId, 'the init line to be handled');

    // The server quits with the setting on: the run is left alone.
    runner.shutdown();
    assert.strictEqual(runner.isRunning(task.id), false, 'the old server forgot the run');
    assert.strictEqual(detached.pidExists(pid), true, 'but the agent process is still running');
    assert.strictEqual(task.status, 'running');

    // The next boot.
    const { reattached, finished } = runner.reattachAll();
    assert.deepStrictEqual(reattached, [task.id], 'the live run is reattached');
    assert.deepStrictEqual(finished, []);
    assert.strictEqual(runner.isRunning(task.id), true, 'it is back in the live pool (permission bridge, capacity, stop)');

    fs.writeFileSync(gate, '');
    await until(() => task.status !== 'running', 'the reattached run to finish', 10000);
    assert.strictEqual(task.status, 'validation', 'the result after the restart lands it normally');
    assert.strictEqual(task.costUsd, 0.01, 'billed once');
    const log = logOf(task.id);
    assert.strictEqual(log.filter((e) => e.type === 'system').length, 1, 'the init line before the restart is not parsed again');
    assert.strictEqual(log.filter((e) => e.type === 'result').length, 1, 'the result is logged once');
    assert.ok(log.some((e) => e.type === 'proc' && e.text === 'Ployd restarted — reattached to the live run'));
    assert.ok(log.some((e) => e.type === 'proc' && e.text === 'Run finished (exit unknown)'),
      'after a restart the outcome comes from the stream, not an exit code');
    assert.deepStrictEqual(runDirs(), [], 'the record is removed once settled');
  } finally {
    restore();
  }
});

test('detached: a run that finished while the server was down is settled from its output file', async () => {
  const runner = require('../server/runner');
  const task = mkTask('det-done', { status: 'running', runCount: 1 });
  const restore = withStore([task]);
  try {
    const { child } = spawnDetached(task.id, 'MODE:quick');
    await exited(child);

    const { finished } = runner.reattachAll();
    assert.deepStrictEqual(finished, [task.id]);
    assert.strictEqual(task.status, 'validation', 'the result in the file is a success');
    assert.strictEqual(task.lastOutcome, 'success');
    assert.strictEqual(task.sessionId, `sess-${child.pid}`, 'the session id is read from the file');
    assert.strictEqual(task.costUsd, 0.01);
    assert.strictEqual(runner.isRunning(task.id), false);
    assert.deepStrictEqual(runDirs(), []);
    assert.ok(logOf(task.id).some((e) => e.type === 'proc' && /ended while it was down/.test(e.text || '')));
  } finally {
    restore();
  }
});

test('detached: lines a previous server already handled are replayed for state only, never billed twice', async () => {
  const runner = require('../server/runner');
  const detached = require('../server/detached');
  // As if the old server had read the whole stream (cost already on the task)
  // and died before it saw the exit.
  const task = mkTask('det-handled', { status: 'running', costUsd: 0.01, sessionId: 'kept' });
  const restore = withStore([task]);
  try {
    const { rec, child } = spawnDetached(task.id, 'MODE:quick');
    await exited(child);
    rec.offset = fs.statSync(rec.stdoutPath).size;
    rec.errOffset = fs.statSync(rec.stderrPath).size;
    detached.writeRecord(rec);

    runner.reattachAll();
    assert.strictEqual(task.status, 'validation', 'the result seen before the restart still decides the outcome');
    assert.strictEqual(task.costUsd, 0.01, 'and is not billed again');
    assert.strictEqual(logOf(task.id).filter((e) => e.type === 'result').length, 0, 'nor logged again');
  } finally {
    restore();
  }
});

test('detached: a run that died without a result fails with a clear line', async () => {
  const runner = require('../server/runner');
  const task = mkTask('det-dead', { status: 'running' });
  const restore = withStore([task]);
  try {
    const { child } = spawnDetached(task.id, 'MODE:noresult');
    await exited(child);
    runner.reattachAll();
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.lastOutcome, 'error');
    assert.strictEqual(task.lastError, 'fake stderr line', 'the stderr tail is the reason when there is one');
    const log = logOf(task.id);
    assert.ok(log.some((e) => e.type === 'proc' && e.text === 'Run failed (exit unknown): fake stderr line'));
    assert.deepStrictEqual(runDirs(), []);
  } finally {
    restore();
  }
});

test('detached: a reused pid (start time mismatch) is treated as gone, never touched', () => {
  const runner = require('../server/runner');
  const detached = require('../server/detached');
  const task = mkTask('det-reused', { status: 'running' });
  const restore = withStore([task]);
  try {
    const dir = detached.runDir(task.id);
    fs.mkdirSync(dir, { recursive: true });
    const tempFile = path.join(ROOT, 'grok-prompt.md');
    fs.writeFileSync(tempFile, 'prompt');
    fs.writeFileSync(path.join(dir, 'stdout.ndjson'), '');
    fs.writeFileSync(path.join(dir, 'stderr.log'), '');
    detached.writeRecord({
      taskId: task.id, kind: 'dispatch', agent: 'claude', pid: process.pid, startTime: 'Mon Jan  1 00:00:00 1990',
      dir, stdinPath: null, stdoutPath: path.join(dir, 'stdout.ndjson'), stderrPath: path.join(dir, 'stderr.log'),
      offset: 0, errOffset: 0, tempFiles: [tempFile], stopped: false, startedAt: '',
    });
    const { finished } = runner.reattachAll();
    assert.deepStrictEqual(finished, [task.id], 'a pid that is someone else now counts as a finished run');
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.lastError, 'The run ended while Ployd was not running, without a result');
    assert.ok(!fs.existsSync(tempFile), 'recorded temp files (a Grok prompt file) are deleted once the run has ended');
    assert.deepStrictEqual(runDirs(), []);
  } finally {
    restore();
  }
});

test('detached: a Code Review run reattached after a restart restores the implementing session', async () => {
  const runner = require('../server/runner');
  const task = mkTask('det-review', { status: 'code_review', sessionId: null });
  const restore = withStore([task]);
  try {
    const { child } = spawnDetached(task.id, 'MODE:quick', { kind: 'codeReview', implementationSessionId: 'impl-1' });
    await exited(child);
    runner.reattachAll();
    assert.strictEqual(task.status, 'validation', 'a review always lands in validation');
    assert.strictEqual(task.lastOutcome, 'reviewed');
    assert.strictEqual(task.sessionId, 'impl-1', 'task.sessionId points back at the implementing session');
  } finally {
    restore();
  }
});

async function waitGone(pid: number): Promise<void> {
  const detached = require('../server/detached');
  await until(() => !detached.pidExists(pid), `pid ${pid} to exit`);
}

test('detached: stop kills the whole process group, before and after a restart', async () => {
  const runner = require('../server/runner');
  for (const restart of [false, true]) {
    const pidFile = path.join(ROOT, `grandchild-${restart}`);
    const task = mkTask(`det-stop-${restart}`);
    const restore = withStore([task]);
    try {
      runner.dispatch(task, `MODE:group:${pidFile}`);
      const pid = runner.liveChildren().find((c: { id: string }) => c.id === task.id).pid;
      spawned.push(pid);
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 'the grandchild');
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      spawned.push(grandchild);

      if (restart) {
        runner.shutdown();
        assert.deepStrictEqual(runner.reattachAll().reattached, [task.id]);
      }
      assert.strictEqual(runner.stop(task.id), true);
      await waitGone(pid);
      await waitGone(grandchild);
      await until(() => task.status !== 'running', 'the stop to settle');
      assert.strictEqual(task.status, 'ready', `a stopped run goes back to ready (restart: ${restart})`);
      assert.strictEqual(task.lastOutcome, 'stopped');
    } finally {
      restore();
    }
  }
});

test('store: a running task with a run record is not marked failed on boot', () => {
  const store = require('../server/store');
  const withRecord = mkTask('mig-1', { status: 'running' });
  store.migrateTask(withRecord, true);
  assert.strictEqual(withRecord.status, 'running', 'left for reattachAll to decide');
  const review = mkTask('mig-2', { status: 'code_review' });
  store.migrateTask(review, true);
  assert.strictEqual(review.status, 'code_review');
  const orphan = mkTask('mig-3', { status: 'running' });
  store.migrateTask(orphan, false);
  assert.strictEqual(orphan.status, 'failed', 'no record keeps the old rule');
  assert.strictEqual(store.DEFAULT_SETTINGS.detachedRuns, false, 'the setting is off by default');
});

// ---------- the permission bridge retrying through a restart ----------

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

test('permission-mcp: a refused connection is retried until the server comes back', async () => {
  const bridge = require('../server/permission-mcp');
  const port = await freePort();
  let server: http.Server | null = null;
  let sleeps = 0;
  const decision = await bridge.askServer({ tool_name: 'Bash', input: { command: 'ls' } }, {
    endpoint: `http://127.0.0.1:${port}/api/tasks/t/permission`,
    firstDelayMs: 20,
    maxDelayMs: 40,
    windowMs: 5000,
    sleep: async (ms: number) => {
      sleeps++;
      // The server "restarts" after the second failed attempt.
      if (sleeps === 2) {
        server = http.createServer((req, res) => {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => res.end(JSON.stringify({ behavior: 'allow', updatedInput: JSON.parse(body).input })));
        });
        await new Promise<void>((r) => server!.listen(port, '127.0.0.1', () => r()));
      }
      await new Promise((r) => setTimeout(r, ms));
    },
  });
  try {
    assert.deepStrictEqual(decision, { behavior: 'allow', updatedInput: { command: 'ls' } }, 'the prompt is re-posted and answered');
    assert.ok(sleeps >= 2, 'it backed off between attempts');
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  }
});

test('permission-mcp: a reset connection (server died mid-prompt) is re-posted', async () => {
  const bridge = require('../server/permission-mcp');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (hits === 1) { req.socket.destroy(); return; }
    res.end(JSON.stringify({ behavior: 'deny', message: 'no' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const decision = await bridge.askServer({ tool_name: 'Bash', input: {} }, {
      endpoint: `http://127.0.0.1:${port}/p`, firstDelayMs: 10, windowMs: 5000,
    });
    assert.deepStrictEqual(decision, { behavior: 'deny', message: 'no' }, 'the second attempt carries the real answer');
    assert.strictEqual(hits, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('permission-mcp: it gives up with a deny once the retry window closes', async () => {
  const bridge = require('../server/permission-mcp');
  const port = await freePort();
  const decision = await bridge.askServer({ tool_name: 'Bash', input: {} }, {
    endpoint: `http://127.0.0.1:${port}/p`, firstDelayMs: 10, maxDelayMs: 20, windowMs: 120,
  });
  assert.strictEqual(decision.behavior, 'deny', 'a server that never returns is a deny, never a hang');
  assert.strictEqual(bridge.RETRY_WINDOW_MS, 30 * 60 * 1000, 'the real window matches the server\'s 30-minute deny timeout');
});

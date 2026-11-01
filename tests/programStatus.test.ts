import test from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Keep the store's (and the terminal list's) on-disk writes out of the repo.
// Set BEFORE any server module is required.
process.env.PLOYD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-test-'));

import {
  StatusParser, parseReport, applyEvent, onInput, reportedStatus, QUERY_REPLY, STALE_WORKING_MS,
} from '../server/programStatus';
import type { Tracked } from '../server/programStatus';

const ST = '\x1b\\';
const BEL = '\x07';

test('programStatus: parses each state, with either terminator', () => {
  for (const state of ['idle', 'working', 'done', 'blocked', 'error', 'clear']) {
    for (const end of [ST, BEL]) {
      const events = new StatusParser().feed(`before\x1b]7501;state=${state}:app=claude-code${end}after`);
      assert.deepStrictEqual(events, [{ type: 'report', report: { state, id: '', app: 'claude-code' } }], `${state} ${JSON.stringify(end)}`);
    }
  }
});

test('programStatus: report fields follow the spec rules', () => {
  assert.deepStrictEqual(parseReport('state=blocked:kind=permission:app=codex'),
    { state: 'blocked', id: '', app: 'codex', kind: 'permission' });
  assert.strictEqual(parseReport('state=working:kind=permission')!.kind, undefined, 'kind is for blocked only');
  assert.strictEqual(parseReport('state=bogus'), null, 'an unknown state ignores the report');
  assert.strictEqual(parseReport('app=x'), null, 'state is required');
  assert.strictEqual(parseReport('state=idle:state=working')!.state, 'working', 'the last repeated key wins');
  assert.strictEqual(parseReport(' state = done :garbage:app=pi')!.state, 'done', 'trimmed; malformed pairs skipped');
  assert.strictEqual(parseReport('state=done:id=a/b')!.id, 'a/b');
  assert.strictEqual(parseReport('state=done:id=a//b'), null, 'an invalid id ignores the report');
  assert.ok(parseReport(`state=done:msg=${Buffer.from('All 12 checks passed').toString('base64')}`));
  assert.strictEqual(parseReport('state=done:msg=a,b.c'), null, 'bad base64 drops the report');
  assert.strictEqual(parseReport(`state=done:msg=${Buffer.from('a\nb').toString('base64')}`), null, 'no control chars');
});

test('programStatus: a sequence split across chunks is finished by the next one', () => {
  const seq = `\x1b]7501;state=working:app=codex${ST}`;
  // Every possible cut point, including inside the ESC \ terminator.
  for (let cut = 1; cut < seq.length; cut++) {
    const p = new StatusParser();
    const first = p.feed(Buffer.from('out' + seq.slice(0, cut), 'latin1'));
    const second = p.feed(Buffer.from(seq.slice(cut) + 'more', 'latin1'));
    assert.deepStrictEqual(first, [], `nothing yet at cut ${cut}`);
    assert.deepStrictEqual(second.map((e) => e.type), ['report'], `one report at cut ${cut}`);
  }
  // Byte by byte, too.
  const p = new StatusParser();
  const events = [...`x${seq}y\x1b]7501;state=done${BEL}`].flatMap((ch) => p.feed(ch));
  assert.deepStrictEqual(events.map((e) => e.type === 'report' && e.report.state), ['working', 'done']);
});

test('programStatus: other output is skipped, and oversized or cancelled sequences are dropped', () => {
  const p = new StatusParser();
  assert.deepStrictEqual(p.feed(`\x1b[31mred\x1b[0m\x1b]0;title${BEL}\x1b]8;;http://x${ST}link\x1b]8;;${ST}`), []);
  assert.deepStrictEqual(p.feed(`\x1b]7501;state=working\x1b[0mtext`), [], 'cancelled by another escape');
  assert.deepStrictEqual(p.feed(`\x1b]7501;state=done:app=${'a'.repeat(5000)}`), [], 'over the limit: not carried');
  assert.deepStrictEqual(p.feed(`${ST}\x1b]7501;state=idle${ST}`).map((e) => e.type), ['report'], 'and it recovers');
  // An unrelated OSC cut mid-body is not carried (nothing to finish).
  const q = new StatusParser();
  assert.deepStrictEqual(q.feed('\x1b]8;;http://example'), []);
  assert.deepStrictEqual(q.feed(`.com${ST}`), []);
});

test('programStatus: the query, a prompt mark and a full reset are recognized', () => {
  const p = new StatusParser();
  assert.deepStrictEqual(p.feed(`\x1b]7501;?${BEL}\x1b[c`), [{ type: 'query' }]);
  assert.deepStrictEqual(p.feed(QUERY_REPLY), [], 'an echoed reply does not ask again');
  assert.deepStrictEqual(p.feed(`\x1b]133;A${ST}`), [{ type: 'prompt' }]);
  assert.deepStrictEqual(p.feed(`\x1b]133;A;cl=m${BEL}\x1b]133;B${BEL}`), [{ type: 'prompt' }]);
  assert.deepStrictEqual(p.feed('\x1bc'), [{ type: 'reset' }]);
  assert.strictEqual(QUERY_REPLY, `\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth${ST}`);
});

function track(...bodies: string[]): Tracked {
  const t: Tracked = { reported: null };
  const p = new StatusParser();
  for (const b of bodies) for (const e of p.feed(b)) applyEvent(t, e);
  return t;
}

test('programStatus: working is active, every other state is idle, and the timer cannot override it', () => {
  const working = track(`\x1b]7501;state=working${ST}`).reported!;
  assert.strictEqual(reportedStatus(working, 0), 'active');
  assert.strictEqual(reportedStatus(working, 5 * 60_000), 'active', 'a thinking agent stays active long past 30s of silence');
  for (const state of ['idle', 'done', 'blocked', 'error']) {
    const r = track(`\x1b]7501;state=${state}${ST}`).reported!;
    assert.strictEqual(reportedStatus(r, 0), 'idle', `${state} is idle even with fresh output`);
  }
});

test('programStatus: the reset rules', () => {
  // The agent's own exit signal.
  assert.strictEqual(track(`\x1b]7501;state=working${ST}`, `\x1b]7501;state=clear${BEL}`).reported, null, 'clear');
  // A child record never touches the root.
  assert.strictEqual(track(`\x1b]7501;state=working${ST}`, `\x1b]7501;state=clear:id=sub${ST}`).reported!.state, 'working');
  assert.strictEqual(track(`\x1b]7501;state=done:id=sub${ST}`).reported, null);
  // A new shell prompt ends working/blocked/idle; done/error survive it.
  for (const state of ['working', 'blocked', 'idle']) {
    assert.strictEqual(track(`\x1b]7501;state=${state}${ST}`, `\x1b]133;A${ST}`).reported, null, state);
  }
  for (const state of ['done', 'error']) {
    assert.strictEqual(track(`\x1b]7501;state=${state}${ST}`, `\x1b]133;A${ST}`).reported!.state, state, state);
  }
  // A full reset removes everything.
  assert.strictEqual(track(`\x1b]7501;state=done${ST}`, '\x1bc').reported, null);
  // A submitted line ends anything but working; plain keys and focus reports don't.
  const done = track(`\x1b]7501;state=done${ST}`);
  onInput(done, 'ls');
  onInput(done, '\x1b[I');
  assert.strictEqual(done.reported!.state, 'done');
  onInput(done, '\r');
  assert.strictEqual(done.reported, null);
  const working = track(`\x1b]7501;state=working${ST}`);
  onInput(working, 'next question\r');
  assert.strictEqual(working.reported!.state, 'working', 'typing ahead does not end a turn');
  // A working report left behind by a crash goes stale after long total silence.
  assert.strictEqual(reportedStatus(working.reported!, STALE_WORKING_MS + 1), 'idle');
});

// ---------- end to end, through a real session ----------

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ptyAvailable = process.platform !== 'win32';

test('terminal: a session that reports OSC 7501 follows the report, not the silence timer', { skip: !ptyAvailable }, async () => {
  const terminal = require('../server/terminal');
  const bus = require('../server/bus');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-7501-'));
  const seen: string[] = [];
  const onEvent = (e: { type: string; session?: { id: string; status: string } }) => {
    if (e.type === 'terminal' && e.session && e.session.id === sid) seen.push(e.session.status);
  };
  let sid = '';
  const off = bus.subscribe(onEvent);
  try {
    const reporter = terminal.create({ cwd: dir, repoId: 'r7501' });
    const silent = terminal.create({ cwd: dir, repoId: 'r7501' });
    sid = reporter.id;
    const s = terminal.get(reporter.id);
    const statusOf = (id: string) => terminal.list().find((x: { id: string }) => x.id === id).status;

    terminal.write(reporter.id, "printf '\\033]7501;state=working:app=test\\033\\\\'\n");
    await until(() => s.reported?.state === 'working');
    // Pretend a minute of silence: the timer would say idle, the report says active.
    s.lastActivity = Date.now() - 60_000;
    terminal.get(silent.id).lastActivity = Date.now() - 60_000;
    assert.strictEqual(statusOf(reporter.id), 'active', 'a reported working state beats 60s of silence');
    assert.strictEqual(statusOf(silent.id), 'idle', 'a session that never reports keeps the 30s timer');

    terminal.write(reporter.id, "printf '\\033]7501;state=done:app=test\\007'\n");
    await until(() => s.reported?.state === 'done');
    s.lastActivity = Date.now(); // fresh output: the timer would say active
    assert.strictEqual(statusOf(reporter.id), 'idle', 'done is idle even right after output');

    // The agent's clear hands the session back to the timer.
    terminal.write(reporter.id, "printf '\\033]7501;state=clear\\033\\\\'\n");
    await until(() => s.reported === null);
    s.lastActivity = Date.now() - 60_000;
    assert.strictEqual(statusOf(reporter.id), 'idle');
    s.lastActivity = Date.now();
    assert.strictEqual(statusOf(reporter.id), 'active');
    assert.ok(seen.includes('idle'), 'transitions went out as terminal bus events');
  } finally {
    off();
    terminal.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal: the server answers the OSC 7501 feature query on the pty', { skip: !ptyAvailable }, async () => {
  const terminal = require('../server/terminal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-7501-'));
  try {
    const sess = terminal.create({ cwd: dir, repoId: 'r7501q' });
    let out = '';
    const unsubscribe = terminal.attach(sess.id, (b64: string) => { out += Buffer.from(b64, 'base64').toString('latin1'); });
    // Ask the way Claude Code does, read the reply back with echo off, and
    // print it with its escape bytes made visible (so it isn't parsed again).
    terminal.write(sess.id,
      "stty raw -echo min 0 time 20; printf '\\033]7501;?\\007'; r=$(dd bs=256 count=1 2>/dev/null); stty sane; " +
      "printf 'REPLY[%s]\\n' \"$r\" | tr '\\033\\007' 'EB'\n");
    await until(() => /REPLY\[E\]7501;\?:states=/.test(out));
    assert.match(out, /REPLY\[E\]7501;\?:states=idle,working,done,blocked,error:kinds=permission,question,authE\\\]/);
    unsubscribe();
  } finally {
    terminal.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

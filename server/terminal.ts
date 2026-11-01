import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { Writable } from 'stream';
import * as bus from './bus';
import { id, DATA_DIR } from './store';
import * as runner from './runner';
import type { SessionAgent } from './types';

// In-app shell sessions. Each session is a real interactive shell running on a
// pseudo-terminal so prompts, colors, and full-screen apps (vim, top) work. We
// get the pty from python3's stdlib `pty` module rather than a native module
// like node-pty, keeping the runtime dependency-free (see CLAUDE.md: express is
// the only dep). python3 ships on macOS dev machines (Command Line Tools) and
// virtually all Linux; Windows has no pty here and falls back to a plain pipe.
//
// A session can boot straight into an agent CLI (`kind`), into one of the
// user's own agents from Settings (`kind: 'custom'` + `agent`, looked up by id
// in the route — never a command from the request), or into a command
// (`command`, e.g. the `npm run dev` behind the workspace's Run button): the
// shell starts as usual and the line is typed into it, so quitting `claude` —
// or Ctrl-C'ing the dev server — leaves you at a live prompt instead of killing
// the tab.
//
// The processes are process-local (they die with this server), but the *list*
// of live sessions is persisted: terminal-sessions.json under PLOYD_DATA_DIR,
// no scrollback. On the next boot restore() brings each one back as a fresh
// login shell at the same checkout, under the same id and label, so the board's
// tabs still point at it. Whatever ran inside (an agent CLI, a package script)
// is not resumed; a dim notice at the top of the new pane says so. The board
// lists sessions via GET /api/terminal/sessions and reattaches to each one's
// output with the stream route.

type Kind = 'shell' | 'claude' | 'codex' | 'grok' | 'custom';
// active = alive and printing; idle = alive but quiet (sitting at a prompt,
// waiting for you); exited = the process is gone. The board renders them as a
// green / amber / red bullet.
type Status = 'active' | 'idle' | 'exited';

interface Session {
  id: string;
  repoId: string;
  cwd: string;
  kind: Kind;
  label: string;
  // The label before its "2"/"3" suffix, so a second session of the same sort
  // in the same repo can be numbered without re-deriving where it came from.
  base: string;
  // The line typed at the fresh prompt for a command session (a package
  // script), else undefined. Kept so the board can label and re-run it.
  command?: string;
  // The Settings id of a custom agent session, so the board can duplicate it.
  agentId?: string;
  child: ChildProcessWithoutNullStreams;
  // The relay's resize channel (fd 3); null on Windows, which has no pty here.
  control: Writable | null;
  // Recent raw output, base64-encoded per chunk, capped so a reconnecting
  // client can repaint the screen without unbounded memory growth.
  buffer: string[];
  bufferBytes: number;
  listeners: Set<(chunk: string) => void>;
  exited: boolean;
  createdAt: string;
  lastActivity: number;
  // The status last broadcast, so the sweep below only emits real transitions.
  status: Status;
}

interface Summary {
  id: string;
  repoId: string;
  cwd: string;
  kind: Kind;
  label: string;
  command?: string;
  agentId?: string;
  status: Status;
  createdAt: string;
}

const sessions = new Map<string, Session>();
const MAX_BUFFER_BYTES = 256 * 1024;
// Quiet for this long and a live session is "idle" rather than "active".
const IDLE_MS = 30_000;
// How often the sweep re-grades every session (only transitions broadcast).
const SWEEP_MS = 5_000;
// Exited sessions stay listed — a red tab you can still scroll back through —
// until dismissed. Cap how many we hold so a long day doesn't grow forever.
const MAX_EXITED = 20;

// The saved list of live sessions (see the header comment). A sibling of
// db.json rather than a field in it: it is runtime state nothing reads through
// /api/state, and it changes on every shell exit, so there's no reason to
// rewrite the whole db for it.
const SAVED_PATH = path.join(DATA_DIR, 'terminal-sessions.json');
// Debounced like store.save, but a little longer: a shell that dies *because*
// the server is going down (a Ctrl-C reaching the relay too) must not get the
// chance to drop itself from the list before the process is gone.
const SAVE_DEBOUNCE_MS = 250;

const KIND_LABEL: Record<Kind, string> = {
  shell: 'Shell', claude: 'Claude', codex: 'Codex', grok: 'Grok', custom: 'Agent',
};

function isKind(v: unknown): v is Kind {
  return v === 'shell' || v === 'claude' || v === 'codex' || v === 'grok' || v === 'custom';
}

// The binary a non-shell session types at its prompt. Uses the same resolved
// bin names the runner spawns tasks with, so a custom CLI path works here too.
function launchBin(kind: Kind): string | null {
  if (kind === 'claude') return runner.CLAUDE_BIN;
  if (kind === 'codex') return runner.CODEX_BIN;
  if (kind === 'grok') return runner.GROK_BIN;
  return null;
}

// The shell echoes what we type at its prompt, so quote only when the path
// actually needs it — the common case should read like the command the user
// would have typed themselves.
function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function statusOf(s: Session): Status {
  if (s.exited) return 'exited';
  return Date.now() - s.lastActivity > IDLE_MS ? 'idle' : 'active';
}

function summary(s: Session): Summary {
  return {
    id: s.id, repoId: s.repoId, cwd: s.cwd, kind: s.kind,
    label: s.label, command: s.command, agentId: s.agentId, status: statusOf(s), createdAt: s.createdAt,
  };
}

function announce(s: Session): void {
  s.status = statusOf(s);
  bus.broadcast({ type: 'terminal', session: summary(s) });
}

// One timer for all sessions, running only while there are any. It exists to
// turn "went quiet" into an event — every other transition is broadcast by the
// code that causes it.
let sweep: NodeJS.Timeout | null = null;
function syncSweep(): void {
  if (sessions.size && !sweep) {
    sweep = setInterval(() => {
      for (const s of sessions.values()) if (statusOf(s) !== s.status) announce(s);
    }, SWEEP_MS);
    sweep.unref();
  } else if (!sessions.size && sweep) {
    clearInterval(sweep);
    sweep = null;
  }
}

// The relay that gives a session its pseudo-terminal: python3's stdlib `pty`
// allocates a real one and this loop shuttles bytes between our pipes and the
// pty master. No native module, so no runtime dependency (see CLAUDE.md).
//
// It is a hand-rolled loop rather than `pty.spawn` for one reason: **fd 3 is a
// resize channel**. Writing `"<cols> <rows>\n"` to it runs a real TIOCSWINSZ
// ioctl on the master, which is the only thing that makes the kernel raise
// SIGWINCH in the shell — so a full-screen app (claude's TUI, vim, top)
// actually re-lays-out when the panel is dragged. Pushing an `stty` through
// stdin, the obvious alternative, only works at a bare prompt and echoes the
// command across the screen every time.
const PTY_RELAY = `
import os, pty, sys, select, struct, fcntl, termios
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(shell, [shell, '-il'])
    except Exception:
        os._exit(127)
def winsz(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError:
        pass
winsz(cols, rows)
CTRL = 3
watch = [fd, 0, CTRL]
buf = b''
while True:
    try:
        readable, _, _ = select.select(watch, [], [])
    except (OSError, ValueError):
        break
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in readable:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b''
        if data:
            os.write(fd, data)
        else:
            watch.remove(0)
    if CTRL in readable:
        try:
            chunk = os.read(CTRL, 4096)
        except OSError:
            chunk = b''
        if not chunk:
            watch.remove(CTRL)
        else:
            buf += chunk
            while b'\\n' in buf:
                line, buf = buf.split(b'\\n', 1)
                parts = line.split()
                if len(parts) == 2:
                    try:
                        winsz(int(parts[0]), int(parts[1]))
                    except ValueError:
                        pass
try:
    os.close(fd)
except OSError:
    pass
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

// Builds the argv that runs the user's login shell on a pty at the given size.
function ptyCommand(shell: string, cols: number, rows: number): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    // No pty without a native module on Windows; run the shell over pipes
    // (degraded: no prompt redraw / full-screen apps, and resize is a no-op).
    // macOS + Linux are the supported targets.
    return { cmd: process.env.COMSPEC || 'cmd.exe', args: [] };
  }
  return { cmd: 'python3', args: ['-c', PTY_RELAY, shell, String(cols), String(rows)] };
}

// A second Claude session in the same repo is "Claude 2" — the tabs and the
// sidebar rows are short, so the number is what tells them apart. A command
// session is labeled with the command itself ("npm run dev"), numbered the
// same way.
function labelFor(repoId: string, base: string): string {
  const n = [...sessions.values()].filter((s) => s.repoId === repoId && s.base === base).length + 1;
  return n > 1 ? `${base} ${n}` : base;
}

// Drops the oldest dismissable (exited) sessions once too many have piled up.
function trimExited(): void {
  const dead = [...sessions.values()].filter((s) => s.exited)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const s of dead.slice(0, Math.max(0, dead.length - MAX_EXITED))) remove(s.id);
}

// Spawns a new shell session rooted at `cwd`. Returns its summary. Throws if
// the shell process can't be spawned. `command` types one line at the fresh
// prompt (a package script — server/scripts.ts builds it); it is a plain shell
// either way, so the session outlives whatever it started.
//
// `restored` is internal to restore() and never reachable from a route: it
// reuses the saved id, label and creation time, and prints `notice` at the top
// of the pane.
function create(opts: {
  agent?: SessionAgent;
  cwd: string; repoId: string; kind?: Kind; command?: string; cols?: number; rows?: number;
  restored?: { id: string; label: string; base: string; createdAt: string; notice: string };
}): Summary {
  const { cwd, repoId, restored } = opts;
  const kind: Kind = isKind(opts.kind) ? opts.kind : 'shell';
  const command = typeof opts.command === 'string' && opts.command.trim() ? opts.command.trim() : undefined;
  const sid = restored && !sessions.has(restored.id) ? restored.id : id();
  const shell = process.env.SHELL || '/bin/bash';
  const { cmd, args } = ptyCommand(shell, opts.cols || 80, opts.rows || 24);
  const child = spawn(cmd, args, {
    cwd,
    // Reuse the task-runner env hardening: strip the API key (so `claude` in
    // the terminal uses the subscription login) and nested-session markers.
    env: { ...runner.childEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    // The fourth pipe is the relay's resize channel (see PTY_RELAY).
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const control = (child.stdio[3] as Writable | undefined) ?? null;

  const base = restored ? restored.base : (command || KIND_LABEL[kind]);
  const session: Session = {
    id: sid,
    repoId,
    cwd,
    kind,
    label: restored ? restored.label : labelFor(repoId, base),
    base,
    command,
    child,
    control,
    buffer: [],
    bufferBytes: 0,
    listeners: new Set(),
    exited: false,
    createdAt: restored ? restored.createdAt : new Date().toISOString(),
    lastActivity: Date.now(),
    status: 'active',
  };
  // A custom agent session is named after its Settings label and numbered the
  // same way ("Aider", "Aider 2"), and types that agent's saved command.
  const { agent } = opts;
  if (agent) {
    session.kind = 'custom';
    session.agentId = agent.id;
    session.base = agent.label;
    session.label = labelFor(repoId, agent.label);
  }
  sessions.set(sid, session);

  const emit = (chunk: Buffer) => {
    const b64 = chunk.toString('base64');
    session.buffer.push(b64);
    session.bufferBytes += b64.length;
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      session.bufferBytes -= session.buffer.shift()!.length;
    }
    session.lastActivity = Date.now();
    if (session.status !== 'active') announce(session);
    for (const fn of session.listeners) fn(b64);
  };
  // A restored session's notice goes first in the buffer, so it is the top line
  // of the pane, above the new shell's prompt, on every replay.
  if (restored) emit(Buffer.from(`\x1b[2m${restored.notice}\x1b[0m\r\n`));
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  const onDead = () => {
    if (session.exited) return;
    session.exited = true;
    for (const fn of session.listeners) fn('');
    announce(session);
    trimExited();
    persist();
  };
  child.on('exit', onDead);
  child.on('error', onDead);

  // Type the agent CLI (or the package script) at the fresh prompt rather than
  // exec'ing it, so the tab survives quitting the agent / stopping the script.
  // The pty buffers this until the shell reads it.
  const bin = launchBin(kind);
  const startup = command || agent?.command || (bin ? shQuote(bin) : null);
  if (startup) child.stdin.write(`${startup}\n`);

  syncSweep();
  bus.broadcast({ type: 'terminal', session: summary(session) });
  persist();
  return summary(session);
}

function get(sid: string): Session | undefined {
  return sessions.get(sid);
}

function list(): Summary[] {
  return [...sessions.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(summary);
}

// Subscribes to a session's output. Immediately replays the buffered output so
// a fresh or reconnecting client repaints the current screen, then streams live
// chunks. An exited session replays and then gets the same empty-chunk "the
// process is gone" marker a live one would send. Returns an unsubscribe
// function, or null when there is no such session.
function attach(sid: string, onChunk: (b64: string) => void): (() => void) | null {
  const s = sessions.get(sid);
  if (!s) return null;
  for (const b64 of s.buffer) onChunk(b64);
  if (s.exited) onChunk('');
  s.listeners.add(onChunk);
  return () => s.listeners.delete(onChunk);
}

function write(sid: string, data: string): boolean {
  const s = sessions.get(sid);
  if (!s || s.exited) return false;
  s.child.stdin.write(data);
  s.lastActivity = Date.now();
  if (s.status !== 'active') announce(s);
  return true;
}

// Live resize: a real TIOCSWINSZ on the pty master, so the shell gets SIGWINCH
// and a full-screen app redraws at the new size. Nothing is written to stdin,
// so it leaves no trace on screen. A no-op on Windows (no pty, no channel).
function resize(sid: string, cols: number, rows: number): boolean {
  const s = sessions.get(sid);
  if (!s || s.exited || !s.control) return false;
  s.control.write(`${cols} ${rows}\n`);
  return true;
}

// Kills the process but keeps the session listed as `exited`, so its tab turns
// red and its scrollback stays readable until the user dismisses it.
function close(sid: string): void {
  const s = sessions.get(sid);
  if (!s || s.exited) return;
  s.child.kill('SIGKILL');
  s.exited = true;
  for (const fn of s.listeners) fn('');
  announce(s);
  trimExited();
  persist();
}

// Kills (if needed) and forgets a session entirely — the tab's × and the
// sidebar's dismiss.
function remove(sid: string): void {
  const s = sessions.get(sid);
  if (!s) return;
  if (!s.exited) s.child.kill('SIGKILL');
  s.exited = true;
  sessions.delete(sid);
  syncSweep();
  bus.broadcast({ type: 'terminal-removed', id: sid });
  persist();
}

// Shutdown (app quit, auto-update relaunch, Ctrl-C on the dev server): write the
// live list as it stands *first*, then kill every shell without letting those
// deaths reach the file. They are the server going away, not the user closing
// tabs, and the next boot should restore exactly what was open.
function closeAll(): void {
  flushSaved();
  suspended = true;
  try {
    for (const sid of [...sessions.keys()]) remove(sid);
  } finally {
    suspended = false;
  }
}

// ---------- persistence: the list of live sessions, restored on boot ----------

// One row per live session. `kind`/`command` are what it was started as, kept
// only so the restore notice can say what didn't come back.
interface SavedSession {
  id: string;
  repoId: string;
  cwd: string;
  kind: Kind;
  label: string;
  base: string;
  command?: string;
  createdAt: string;
}

let saveTimer: NodeJS.Timeout | null = null;
let suspended = false;

function savedRows(): SavedSession[] {
  return [...sessions.values()]
    .filter((s) => !s.exited)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => ({
      id: s.id, repoId: s.repoId, cwd: s.cwd, kind: s.kind,
      label: s.label, base: s.base, command: s.command, createdAt: s.createdAt,
    }));
}

// Writes the live list now, atomically (temp file + rename, like db.json).
// Best effort: a failed write must never take a terminal route down with it.
function flushSaved(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (suspended) return;
  try {
    const tmp = SAVED_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: savedRows() }, null, 2));
    fs.renameSync(tmp, SAVED_PATH);
  } catch (e) {
    console.error('[terminal] failed to save the session list:', (e as Error).message);
  }
}

// Called on every change to the live set: create, close, remove, exit.
function persist(): void {
  if (suspended || saveTimer) return;
  saveTimer = setTimeout(flushSaved, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

// The saved list as written, minus any malformed row. A missing or unreadable
// file means there is nothing to restore.
function readSaved(): SavedSession[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(SAVED_PATH, 'utf8'));
  } catch {
    return [];
  }
  const rows = (raw as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(rows)) return [];
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const seen = new Set<string>();
  const out: SavedSession[] = [];
  for (const r of rows as Array<Record<string, unknown> | null>) {
    if (!r || !str(r.id) || !/^[\w-]{1,64}$/.test(r.id) || seen.has(r.id)) continue;
    if (!str(r.repoId) || !str(r.cwd) || !isKind(r.kind) || !str(r.label)) continue;
    seen.add(r.id);
    out.push({
      id: r.id, repoId: r.repoId, cwd: r.cwd, kind: r.kind, label: r.label,
      base: str(r.base) ? r.base : r.label,
      command: str(r.command) ? r.command : undefined,
      createdAt: str(r.createdAt) ? r.createdAt : new Date().toISOString(),
    });
  }
  return out;
}

function noticeFor(s: SavedSession): string {
  if (s.command) return `Restored after restart. "${s.command}" was not restarted.`;
  // A custom agent is named by its own label ("Aider"), not the generic "Agent".
  const what = s.kind === 'custom' ? s.base : KIND_LABEL[s.kind];
  if (s.kind !== 'shell') return `Restored after restart. The previous ${what} session ended.`;
  return 'Restored after restart.';
}

// Boot: recreate each saved session as a plain login shell at its checkout,
// under its old id and label. `resolveCwd` is the caller's checkout check (the
// same one the terminal routes use); a row it rejects (repo unregistered,
// worktree removed, directory gone) is skipped, so the saved file can never
// open a shell anywhere a route couldn't. A restored session is a `shell` with
// no command: nothing is typed at its prompt, and the board must not show an
// agent or a play glyph for something that is no longer running.
async function restore(
  resolveCwd: (repoId: string, cwd: string) => Promise<string | null>,
): Promise<Summary[]> {
  const restored: Summary[] = [];
  for (const s of readSaved()) {
    let cwd: string | null = null;
    try {
      cwd = await resolveCwd(s.repoId, s.cwd);
    } catch {
      cwd = null;
    }
    if (!cwd) continue;
    try {
      restored.push(create({
        cwd, repoId: s.repoId, kind: 'shell',
        restored: { id: s.id, label: s.label, base: s.base, createdAt: s.createdAt, notice: noticeFor(s) },
      }));
    } catch (e) {
      console.error('[terminal] failed to restore a session:', (e as Error).message);
    }
  }
  // Rewrite the list now, so skipped rows are gone even if nothing else changes.
  flushSaved();
  return restored;
}

export { create, get, list, attach, write, resize, close, remove, closeAll, isKind, restore, flushSaved, readSaved, SAVED_PATH };
export type { Kind, Status, Summary, SavedSession };

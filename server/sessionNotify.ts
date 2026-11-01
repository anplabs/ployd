/*
 * Session notices — a terminal session's agent hears back about the tasks it
 * created.
 *
 * An interactive agent running in a Ployd terminal session (server/terminal.ts)
 * can queue board tasks over the /mcp server. create_task records the session
 * that asked (task.originSessionId). This module watches the bus, and when such
 * a task lands — `validation`, `failed` or `done`; `code_review` is still in
 * flight, the same rule as the orchestrator engine — it types ONE line into
 * that session and submits it, so the agent reads the result as a message:
 *
 *   [ployd] task 3f9a01bc2d "Fix login redirect" finished: validation, grade 4/5, PR https://… - get_task 3f9a01bc2d for details
 *
 * Typing into a live terminal is the sharp edge here, so every rule below is
 * about never typing the wrong thing, or into the wrong program:
 *
 *   - The line is built here, never taken from a request. Every piece of task
 *     text in it (title, error) goes through sanitizeText — escape sequences
 *     removed whole, every control character (newlines included) turned into a
 *     space, length capped — and then has the characters a POSIX shell expands
 *     inside double quotes taken out. A title can't add a keystroke, end the
 *     line early, or run anything if the line ever reached a shell.
 *   - Only agent sessions (claude / codex / grok) get notices; a plain shell
 *     would run the line as a command. An exited session drops its queue.
 *   - Only when the session is `idle`. While it is `active` the notice waits in
 *     a queue and goes out on the next idle transition, one notice per idle.
 *   - Not while the user has a half-typed line (the notice would be glued onto
 *     it and submitted with it) — terminal.ts tracks that as `draft`.
 *   - Not while a menu or a yes/no prompt is what the program drew last — a
 *     tool-approval dialog, a trust prompt, an "update now?" picker. There the
 *     notice's Enter would choose the highlighted option (approve a tool, run
 *     an update) instead of sending a message. menuOnScreen reads what the
 *     session printed since its last input for the shapes those take. It is a heuristic, so it
 *     errs towards waiting: a false alarm only delays the notice.
 *   - Only while the agent itself is the terminal's foreground program. An
 *     agent session whose agent was quit is a shell at a prompt; the process
 *     table says which (agentInForeground), and until the agent is back the
 *     notice waits. On Windows (no pty, no process groups) it never goes out.
 *   - Framed as a bracketed paste when the program asked for that mode — a TUI
 *     like claude's treats a fast burst of text ending in Enter as a paste and
 *     won't submit it otherwise — then submitted with Enter (`\r`).
 *
 * Queues are process-local and never persisted, like the sessions themselves.
 * Settings.notifySessions turns the whole thing off.
 */
import { execFile } from 'child_process';
import path from 'path';

import { db, getTask } from './store';
import { subscribe } from './bus';
import * as terminal from './terminal';
import * as github from './github';
import * as runner from './runner';
import * as sessionAgents from './sessionAgents';
import type { Task, TaskStatus } from './types';

// Statuses that mean "this task landed". `code_review` is deliberately absent:
// a task being graded lands in `validation` next.
const TERMINAL: TaskStatus[] = ['validation', 'failed', 'done'];
// Session kinds whose program is an agent that reads the line as a message.
const AGENT_KINDS = new Set<string>(['claude', 'codex', 'grok', 'custom']);

// Caps for task-derived text, and for the whole line as a last word.
const MAX_TITLE = 80;
const MAX_ERROR = 160;
const MAX_LINE = 400;
// At most this many notices wait per session; the oldest goes first.
const MAX_QUEUE = 10;

// A run that lands in `validation` may flow into `code_review` a moment later;
// wait this long so it reports once, after the grade, not twice.
let debounceMs = 4000;

// ---------- the line ----------

/* eslint-disable no-control-regex -- matching control characters is the point */
const ESC_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC_STRING = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g;
const ESC_OTHER = /\x1b[\s\S]?/g;
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]/g;
const C1_STRING = /[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\x07|\u009c|$)/g;
// C0, DEL + C1, the line/paragraph separators, zero-width and bidi marks, BOM.
const CONTROL_RANGES: Array<[number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
];
const CONTROLS = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`, 'gu');
/* eslint-enable no-control-regex */

// Makes arbitrary text safe to type into a terminal as part of one line:
// escape sequences (CSI, OSC/DCS/APC strings, two-byte ESC forms, and their
// 8-bit C1 spellings) are removed whole so no fragment of one survives; every
// other control character — C0 (newline, CR, tab, ESC, …), DEL, C1, the
// Unicode line/paragraph separators and the invisible bidi/zero-width marks —
// becomes a space; whitespace collapses; and the result is capped at `max`
// code points (an ellipsis marks a cut).
function sanitizeText(value: unknown, max: number): string {
  let s = typeof value === 'string' ? value : String(value ?? '');
  s = s
    .replace(ESC_CSI, '')
    .replace(ESC_STRING, '')
    .replace(ESC_OTHER, '')
    .replace(C1_CSI, '')
    .replace(C1_STRING, '')
    .replace(CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…';
  return s;
}

// sanitizeText, plus nothing a POSIX shell would act on inside double quotes:
// `"` and backquote become an apostrophe, `$`, `\` and `!` (history expansion)
// are dropped. The quoted fields of the line can't break out of their quotes.
function quotedText(value: unknown, max: number): string {
  return sanitizeText(sanitizeText(value, max * 2).replace(/["`]/g, '\'').replace(/[$\\!]/g, ''), max);
}

// A PR URL is typed outside the quotes, so it must be plain: an http(s) URL of
// path characters only (no query, fragment or shell metacharacters), or nothing.
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  return /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(value) ? value : null;
}

// The one line a landed task is announced with. Everything outside the quoted
// fields is either fixed text or a value checked against a strict pattern.
function noticeFor(task: Task, prUrl?: string | null): string {
  const id = /^[\w-]{1,64}$/.test(task.id) ? task.id : '?';
  const status = TERMINAL.includes(task.status) ? task.status : 'unknown';
  const parts = [`finished: ${status}`];
  const grade = Math.trunc(Number(task.codeReview?.grade));
  if (task.codeReview && grade >= 1 && grade <= 5) parts.push(`grade ${grade}/5`);
  const url = safeUrl(prUrl);
  if (url) parts.push(`PR ${url}`);
  if (status === 'failed' && task.lastError) parts.push(`error "${quotedText(task.lastError, MAX_ERROR)}"`);
  const line = `[ployd] task ${id} "${quotedText(task.title, MAX_TITLE)}" ${parts.join(', ')} - get_task ${id} for details`;
  // Every piece is already clean; this is the backstop for the line as a whole.
  return sanitizeText(line, MAX_LINE);
}

// ---------- is a menu or a prompt on screen? ----------

// What a selection menu or a confirmation looks like in the agents we start:
// a highlighted numbered option (claude `❯ 1. Yes`, codex `› 1. Update now`),
// the question itself, the y/n forms, and "press enter".
const MENU_PATTERNS: RegExp[] = [
  /[\u276f\u203a>]\s*\d+[.)]\s/,
  /\b(?:do you want to|would you like to|do you trust)\b/i,
  /\bpress enter to\b/i,
  /\b(?:yes, (?:proceed|allow|and)|no, and tell)\b/i,
  /[([]\s*y\s*\/\s*n\s*[)\]]/i,
];

// The visible text of a stretch of raw terminal output: escape sequences out,
// runs of whitespace (cursor moves leave plenty) folded to one space.
function screenText(raw: string): string {
  return raw
    .replace(ESC_CSI, ' ')
    .replace(ESC_STRING, ' ')
    .replace(ESC_OTHER, ' ')
    .replace(CONTROLS, ' ')
    .replace(/\s+/g, ' ');
}

function menuOnScreen(raw: string): boolean {
  const text = screenText(raw);
  return MENU_PATTERNS.some((re) => re.test(text));
}

// What actually goes down the pty: the line, as a bracketed paste when the
// program asked for one, then Enter.
function frame(line: string, pasteMode: boolean): string {
  const clean = sanitizeText(line, MAX_LINE);
  return pasteMode ? `\x1b[200~${clean}\x1b[201~\r` : `${clean}\r`;
}

// ---------- is the agent the program in front? ----------

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  args: string;
}

function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], args: m[5] });
  }
  return rows;
}

// The program names an agent session's foreground process may show up as: the
// basename of the bin the session typed (a custom CLI path included). A custom
// agent is matched on the program its saved command starts (`aider` for
// `aider --model x`); one that is gone from Settings matches nothing.
function agentNames(kind: string, agentId?: string): string[] {
  if (kind === 'custom') {
    const agent = sessionAgents.find(db.settings.sessionAgents, agentId);
    const prog = agent ? sessionAgents.programOf(agent.command) : null;
    return prog ? [path.basename(prog).replace(/\.(exe|cmd|bat)$/i, '')] : [];
  }
  const bin = kind === 'claude' ? runner.CLAUDE_BIN : kind === 'codex' ? runner.CODEX_BIN : kind === 'grok' ? runner.GROK_BIN : '';
  if (!bin) return [];
  const base = path.basename(bin).replace(/\.(exe|cmd|bat)$/i, '');
  return [...new Set([base, kind])];
}

// Is the terminal's foreground process group the agent, rather than the shell
// (agent quit, back at the prompt) or some other program? `relayPid` is the
// pty relay; the shell is its child, and the shell's controlling terminal's
// foreground group (tpgid) is whatever owns the keyboard. An agent launched
// through an interpreter (`node …/codex`) is matched on its script's name.
function agentInForeground(rows: PsRow[], relayPid: number, kind: string, agentId?: string): boolean {
  const names = agentNames(kind, agentId);
  if (!names.length) return false;
  const shell = rows.find((r) => r.ppid === relayPid);
  if (!shell || shell.tpgid <= 0 || shell.tpgid === shell.pgid) return false;
  const named = (token: string | undefined) => !!token && names.includes(path.basename(token));
  return rows.some((r) => {
    if (r.pgid !== shell.tpgid) return false;
    const [cmd, arg] = r.args.split(/\s+/);
    return named(cmd) || named(arg);
  });
}

function readPs(): Promise<PsRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,args='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parsePs(String(stdout))));
  });
}

// ---------- the boundaries (stubbed by the tests) ----------

interface Deps {
  target(sid: string): terminal.NotifyTarget | null;
  write(sid: string, data: string): boolean;
  // Is the session's agent the terminal's foreground program right now?
  foreground(target: terminal.NotifyTarget): Promise<boolean>;
  // The task's PR URL, if it has one.
  prUrl(task: Task): Promise<string | null>;
}

const defaultDeps: Deps = {
  target: (sid) => terminal.notifyTarget(sid),
  write: (sid, data) => terminal.write(sid, data),
  foreground: async (t) => {
    if (process.platform === 'win32' || !t.pid) return false;
    return agentInForeground(await readPs(), t.pid, t.kind, t.agentId);
  },
  prUrl: async (task) => {
    if (!task.branch) return null;
    const timeout = new Promise<null>((resolve) => { setTimeout(() => resolve(null), 10_000).unref(); });
    const lookup = github.prForTask(task).then((r) => r.pr?.url ?? null, () => null);
    return Promise.race([lookup, timeout]);
  },
};
let deps: Deps = defaultDeps;

// ---------- the queue ----------

const queues = new Map<string, string[]>();
// Sessions with a delivery in progress (the foreground probe is async).
const busy = new Set<string>();

const enabled = () => db.settings.notifySessions !== false;
const isAgent = (t: terminal.NotifyTarget | null): t is terminal.NotifyTarget =>
  !!t && t.status !== 'exited' && AGENT_KINDS.has(t.kind);

// Queue a notice for a session and try to deliver it. Dropped (false) when the
// session is gone, exited, or not an agent session, or the setting is off.
function enqueue(sid: string, line: string): boolean {
  if (!enabled() || !isAgent(deps.target(sid))) return false;
  const q = queues.get(sid) || [];
  q.push(line);
  while (q.length > MAX_QUEUE) q.shift();
  queues.set(sid, q);
  void pump(sid);
  return true;
}

// Deliver the next queued notice if the session is ready for it. Every "not
// now" leaves the queue alone; the next idle transition calls this again.
async function pump(sid: string): Promise<void> {
  const q = queues.get(sid);
  if (!q || !q.length || busy.has(sid)) return;
  const t = deps.target(sid);
  if (!enabled() || !isAgent(t)) { queues.delete(sid); return; }
  if (t.status !== 'idle' || t.draft || menuOnScreen(t.tail)) return;
  busy.add(sid);
  let front = false;
  try {
    front = await deps.foreground(t);
  } catch {
    front = false;
  } finally {
    busy.delete(sid);
  }
  if (!front) return;
  // The probe took a moment: look again before typing anything.
  const now = deps.target(sid);
  if (!enabled() || !isAgent(now)) { queues.delete(sid); return; }
  if (now.status !== 'idle' || now.draft || menuOnScreen(now.tail)) return;
  const line = q.shift();
  if (!q.length) queues.delete(sid);
  if (line) deps.write(sid, frame(line, now.pasteMode));
}

// Drop every queued notice (the setting was turned off).
function clear(): void {
  queues.clear();
}

function pending(sid: string): string[] {
  return [...(queues.get(sid) || [])];
}

// ---------- landings ----------

// taskId -> the terminal status we already announced (or that was already
// there at boot), so a re-broadcast of the same state never announces twice.
// Cleared when the task leaves the terminal set (it was dispatched again).
const landed = new Map<string, TaskStatus>();
const timers = new Map<string, NodeJS.Timeout>();

function cancel(taskId: string): void {
  const timer = timers.get(taskId);
  if (timer) clearTimeout(timer);
  timers.delete(taskId);
}

function onTask(task: Task): void {
  if (!task.originSessionId) return;
  if (!TERMINAL.includes(task.status)) {
    landed.delete(task.id);
    cancel(task.id);
    return;
  }
  if (landed.get(task.id) === task.status || timers.has(task.id)) return;
  const timer = setTimeout(() => { void land(task.id); }, debounceMs);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(task.id, timer);
}

// The debounce ran out: if the task is still landed, announce it once.
async function land(taskId: string): Promise<void> {
  timers.delete(taskId);
  const task = getTask(taskId);
  if (!task || !task.originSessionId || !TERMINAL.includes(task.status)) return;
  if (landed.get(taskId) === task.status) return;
  landed.set(taskId, task.status);
  if (!enabled() || !isAgent(deps.target(task.originSessionId))) return;
  const prUrl = await deps.prUrl(task).catch(() => null);
  // The PR lookup can take a while; announce what is true now.
  if (task.status !== landed.get(taskId)) return;
  enqueue(task.originSessionId, noticeFor(task, prUrl));
}

function onBus(msg: unknown): void {
  const m = msg as { type?: string; task?: Task; taskId?: string; session?: terminal.Summary; id?: string };
  if (m.type === 'task' && m.task) {
    onTask(m.task);
  } else if (m.type === 'task-removed' && m.taskId) {
    cancel(m.taskId);
    landed.delete(m.taskId);
  } else if (m.type === 'terminal' && m.session) {
    if (m.session.status === 'idle') void pump(m.session.id);
    else if (m.session.status === 'exited') queues.delete(m.session.id);
  } else if (m.type === 'terminal-removed' && m.id) {
    queues.delete(m.id);
  }
}

let unsubscribe: (() => void) | null = null;

// Subscribe to the bus, and treat every linked task that is already landed as
// announced, so a restart (or a later broadcast of the same state) is quiet.
function start(): void {
  for (const t of db.tasks) {
    if (t.originSessionId && TERMINAL.includes(t.status)) landed.set(t.id, t.status);
  }
  if (!unsubscribe) unsubscribe = subscribe(onBus);
}

function stop(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  for (const id of [...timers.keys()]) cancel(id);
  landed.clear();
  queues.clear();
  busy.clear();
}

// Test seams: swap the boundaries and the debounce.
function _setDeps(next: Partial<Deps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}
function _setDebounce(ms: number): void {
  debounceMs = ms;
}

export {
  start, stop, clear, enqueue, pump, pending, noticeFor, frame, sanitizeText, quotedText, safeUrl, menuOnScreen,
  parsePs, agentInForeground, _setDeps, _setDebounce, TERMINAL, MAX_LINE,
};
export type { PsRow };

import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { spawnCompat } from './spawnCompat';
import { db, save, flush, now, appendLog, getTask } from './store';
import * as detached from './detached';
import type { RunKind, RunRecord } from './detached';
import { broadcast } from './bus';
import * as groomer from './groomer';
import * as orchestrator from './orchestrator';
import * as reviewer from './reviewer';
import * as github from './github';
import { askPrompt } from './ask';
import * as memory from './memory';
import * as permissions from './permissions';
import * as usage from './usage';
import * as claude from './agents/claude';
import * as codex from './agents/codex';
import * as grok from './agents/grok';
import { ClaudeAdapter } from './agents/claude';
import { CodexAdapter } from './agents/codex';
import { GrokAdapter } from './agents/grok';
import type { AgentAdapter, NormalizedResult, PromptDelivery } from './agents/types';
import type { GroomSpec } from './groomer';
import type { AskSession, Grooming, LogEvent, Orchestration, PrInfo, Task, TaskAgent } from './types';

// The registered agent backends, keyed by Task.agent. Claude is the default and
// the historical behavior; codex drives the OpenAI Codex CLI and grok the xAI
// Grok CLI. Grooming always runs against Claude (a Grooming has no agent field)
// — see groom().
const ADAPTERS: Record<TaskAgent, AgentAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  grok: GrokAdapter,
};

function adapterFor(agent: TaskAgent | undefined): AgentAdapter {
  return ADAPTERS[agent as TaskAgent] || ClaudeAdapter;
}

// A live child, tagged so the exit handler can tell a user-requested stop
// (SIGTERM we sent) from a natural exit. `startedAt` is stamped at spawn for the
// resource monitor (see liveChildren).
type RunningChild = ChildProcess & { wasStopped?: boolean; startedAt?: string };

// One entry in the shared pool of live runs. An attached run is its
// ChildProcess itself. A detached run (see launchDetached) is a small handle
// instead — after a restart there is no ChildProcess at all — whose kill()
// signals the run's whole process group, and whose `detached` is the watcher
// tailing its output file.
interface LiveRun {
  readonly pid?: number;
  startedAt?: string;
  wasStopped?: boolean;
  kill(signal?: NodeJS.Signals): unknown;
  detached?: DetachedRun;
}

// taskId / groomingId -> live run (tasks and groomings share the pool, so
// runningCount measures every live agent child against the parallel cap).
const running = new Map<string, LiveRun>();

// How often a detached run's output file is polled for new lines.
const POLL_MS = 250;
// A reattached run (no ChildProcess, so no 'exit' event) is checked for life
// every this many polls.
const ALIVE_EVERY = 4;

// The session-tracking fields Task and Grooming share — everything launch()
// needs to stream an agent child into the log + SSE bus. `status` is the
// wider string here because the two lifecycles use different unions; each
// caller's resolveExit assigns only its own statuses.
interface SessionRecord {
  id: string;
  status: string;
  // The selected model — a built-in alias, 'default', or a custom model id. Both
  // Task and Grooming carry it; launch() uses it to layer any custom-model env.
  model: string;
  sessionId: string | null;
  resolvedModel: string | null;
  costUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  activeSubagents: number;
  lastOutcome: string | null;
  lastError: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

function isRunning(taskId: string): boolean {
  return running.has(taskId);
}

// Count of live agent child processes across both dispatched runs and grooming
// sessions (they share the `running` map) — what the max-parallel-sessions cap
// in index.ts measures against.
function runningCount(): number {
  return running.size;
}

// The live agent children, for the resource monitor (server/resources.ts): the
// pid of each spawned CLI, keyed by the task / grooming / orchestration / ask
// session it belongs to. Read-only — nothing here may be used to kill a child
// (that's runner.stop, which also tags the child as user-stopped).
interface LiveChild {
  id: string;
  pid: number | null;
  startedAt: string | null;
}

function liveChildren(): LiveChild[] {
  return [...running.entries()].map(([id, child]) => ({
    id,
    pid: child.pid ?? null,
    startedAt: child.startedAt || null,
  }));
}

function emitTask(task: Task): void {
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
}

function emitGrooming(grooming: Grooming): void {
  grooming.updatedAt = now();
  save();
  broadcast({ type: 'grooming', grooming });
}

function emitOrchestration(orchestration: Orchestration): void {
  orchestration.updatedAt = now();
  save();
  broadcast({ type: 'orchestration', orchestration });
}

function record(rec: SessionRecord, event: LogEvent): void {
  event.ts = event.ts || now();
  appendLog(rec.id, event);
  broadcast({ type: 'log', taskId: rec.id, event });
}

interface ExitInfo {
  // null when unknown — a detached run that ended while the server was down
  // (the server is no longer its parent, so it never sees the exit status).
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: boolean;
  // The terminal result of the run, normalized across backends (null if the run
  // exited without ever emitting one — e.g. a crash or a launch failure).
  sawResult: NormalizedResult | null;
  stderrTail: string;
  // A failure reason to use instead of "<cli> exited with code N" when there is
  // no exit code to quote (a detached run that died without a result).
  fallbackError?: string;
}

// "exit 0" for a log line, or "exit unknown" when the code was never seen.
function exitText(code: number | null): string {
  return `exit ${code === null ? 'unknown' : code}`;
}

interface LaunchOpts {
  adapter: AgentAdapter;
  args: string[];
  workDir: string;
  prompt: string;
  promptEvent: LogEvent;
  // How to persist + broadcast the record after a field change (emitTask for
  // tasks, emitGrooming for grooming cards). Typed loosely so both fit; launch
  // narrows it to its own record type.
  emit: (rec: any) => void;
  resolveExit: (info: ExitInfo) => void;
  // Called after the shared cost/turns/duration bookkeeping on every result
  // event, so each lifecycle can extend the usage ledger with its own record
  // shape (dispatch -> usage.applyResult, groom -> usage.applyGroomResult)
  // without launch() itself needing to know which one it's driving. The event is
  // the adapter's normalized usage payload (see NormalizedResult.usageEvent).
  onResult?: (event: Record<string, unknown>) => void;
  // Whether the session id from this run's init event is recorded on the record.
  // Defaults to true. A Code Review run (see codeReview) streams into the task's
  // own card but is a *different, throwaway* session, so it opts out — otherwise
  // it would clobber task.sessionId and break follow-ups and Autonomous Mode's
  // review pass, which both resume the implementing session.
  trackSession?: boolean;
  // Set by the run types that may be detached (dispatch, codeReview): what a
  // later server needs to finish the run from its record alone. Only acted on
  // when Settings.detachedRuns is on and the platform supports it.
  detach?: { kind: RunKind; implementationSessionId?: string | null };
}

// Whether a run that CAN be detached should be, right now.
function detachedEnabled(): boolean {
  return !!db.settings.detachedRuns && detached.supported();
}

// What the agent's stream has told us so far, plus the per-line handlers that
// update it. Shared by the pipe path, the detached watcher, and reattach's
// replay, so all three read a stream exactly the same way.
interface StreamState {
  sawResult: NormalizedResult | null;
  stderrTail: string;
  openSubagents: Set<string>;
  // Set whenever a line changed the record (and so asked for a save). A detached
  // run flushes db.json before moving its read offset past such a line.
  dirty: boolean;
}

interface Stream {
  st: StreamState;
  line: (line: string) => void;
  errLine: (line: string) => void;
  replay: (line: string) => void;
}

function streamInto<T extends SessionRecord>(
  rec: T,
  adapter: AgentAdapter,
  emit: (rec: any) => void,
  onResult: ((event: Record<string, unknown>) => void) | undefined,
  trackSession: boolean,
): Stream {
  const st: StreamState = { sawResult: null, stderrTail: '', openSubagents: new Set(), dirty: false };
  const changed = (): void => {
    st.dirty = true;
    emit(rec);
  };
  return {
    st,
    line(line: string): void {
      const norm = adapter.parseLine(line);
      if (!norm) return;

      // Keep hot record fields in sync with the session stream.
      if (norm.session) {
        if (trackSession) rec.sessionId = norm.session.sessionId || rec.sessionId;
        rec.resolvedModel = norm.session.model || rec.resolvedModel;
        changed();
      }
      if (norm.subagentsOpened) {
        for (const id of norm.subagentsOpened) {
          st.openSubagents.add(id);
          rec.activeSubagents = st.openSubagents.size;
          changed();
        }
      }
      if (norm.subagentsClosed) {
        for (const id of norm.subagentsClosed) {
          if (st.openSubagents.delete(id)) {
            rec.activeSubagents = st.openSubagents.size;
            changed();
          }
        }
      }
      if (norm.result) {
        st.sawResult = norm.result;
        rec.costUsd = (rec.costUsd || 0) + (norm.result.costUsd || 0);
        rec.numTurns = norm.result.numTurns;
        rec.durationMs = norm.result.durationMs;
        if (onResult) onResult(norm.result.usageEvent);
        changed();
      }

      record(rec, norm.log);
    },
    errLine(line: string): void {
      st.stderrTail = (st.stderrTail + '\n' + line).slice(-4000);
      record(rec, { type: 'stderr', text: line });
    },
    // A line a previous server already handled: rebuild what it told us (the
    // open subagents, the result) without recording, billing or saving again.
    replay(line: string): void {
      const norm = adapter.parseLine(line);
      if (!norm) return;
      for (const id of norm.subagentsOpened || []) st.openSubagents.add(id);
      for (const id of norm.subagentsClosed || []) st.openSubagents.delete(id);
      if (norm.result) st.sawResult = norm.result;
    },
  };
}

/**
 * Spawn an agent CLI for a task or grooming card and stream its NDJSON output
 * into the session log + SSE bus. Shared by dispatch (running tasks) and groom
 * (grooming cards): the caller picks the adapter, sets the record's starting
 * fields, and provides `resolveExit`, which decides the final status once the
 * process exits. The runner reacts only to the adapter's NormalizedEvents, so it
 * stays provider-agnostic; the process error/cleanup path is handled here.
 *
 * A dispatch or Code Review run is handed to launchDetached instead when
 * Settings.detachedRuns is on (see docs/specs/detached-runner.md).
 */
function launch<T extends SessionRecord>(rec: T, opts: LaunchOpts): T {
  const { adapter, args, workDir, prompt, promptEvent, emit, resolveExit, onResult, trackSession = true } = opts;
  if (running.has(rec.id)) throw new Error('Task is already running');

  record(rec, promptEvent);

  // Most backends read the prompt from stdin. One whose headless mode ignores it
  // (Grok) hands back extra args carrying the prompt instead, plus a cleanup for
  // whatever they point at — see AgentAdapter.promptArgs.
  const delivery = adapter.promptArgs ? adapter.promptArgs(prompt) : null;
  let cleanedUp = false;
  const cleanupPrompt = (): void => {
    if (cleanedUp || !delivery || !delivery.cleanup) return;
    cleanedUp = true;
    try {
      delivery.cleanup();
    } catch (e) {
      // Losing a temp file is not worth failing a finished run over.
      console.warn('[runner] prompt cleanup failed:', (e as Error).message);
    }
  };

  if (opts.detach && detachedEnabled()) return launchDetached(rec, opts, delivery, cleanupPrompt);

  let child: RunningChild;
  try {
    child = spawnCompat(adapter.bin, delivery ? [...args, ...delivery.args] : args, {
      cwd: workDir,
      env: adapter.childEnv(rec.model),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A synchronous spawn failure (bad workDir, bad options) never reaches the
    // 'error'/'exit' handlers below, so clean up here before rethrowing —
    // otherwise a prompt file would be left behind in the temp dir.
    cleanupPrompt();
    throw e;
  }
  child.startedAt = now(); // for the resource monitor's session rows (liveChildren)
  running.set(rec.id, child);

  child.stdin?.on('error', () => {}); // the child may exit before reading stdin
  // Only write the prompt when stdin IS the delivery channel; either way close it
  // so a child that does read stdin sees EOF instead of waiting on us.
  if (!delivery) child.stdin?.write(prompt);
  child.stdin?.end();

  const stream = streamInto(rec, adapter, emit, onResult, trackSession);
  readline.createInterface({ input: child.stdout! }).on('line', stream.line);
  readline.createInterface({ input: child.stderr! }).on('line', stream.errLine);

  child.on('error', (err) => {
    running.delete(rec.id);
    // The child never started, so nothing will read the prompt file. ('exit' may
    // or may not follow an 'error'; cleanupPrompt is idempotent either way.)
    cleanupPrompt();
    failLaunch(rec, adapter, err, emit);
  });

  child.on('exit', (code, signal) => {
    running.delete(rec.id);
    cleanupPrompt();
    // Deny any prompts still waiting — the child that asked is gone.
    permissions.rejectForTask(rec.id, 'Run ended');
    rec.finishedAt = now();
    rec.activeSubagents = 0;
    resolveExit({ code, signal, stopped: !!child.wasStopped, sawResult: stream.st.sawResult, stderrTail: stream.st.stderrTail });
    emit(rec);
  });

  return rec;
}

// The child could not be started at all (e.g. the CLI is not installed).
function failLaunch(rec: SessionRecord, adapter: AgentAdapter, err: Error, emit: (rec: any) => void): void {
  rec.status = 'failed';
  rec.lastOutcome = 'error';
  rec.lastError = `Failed to launch ${adapter.label}: ${err.message}`;
  rec.finishedAt = now();
  rec.activeSubagents = 0;
  record(rec, { type: 'proc', text: rec.lastError });
  emit(rec);
}

// The watcher of one detached run: tails its output files into the stream
// handlers and finishes the run once it is known to have ended.
interface DetachedRun {
  record: RunRecord;
  // Read whatever is left and settle the run (resolveExit, cleanup, record removal).
  finish(opts: { code: number | null; fallbackError?: string }): void;
  // Stop watching but leave the process running (the server is quitting).
  detach(): void;
  // Remember that the user stopped it — on disk, so it survives a restart.
  markStopped(): void;
}

function watchRun<T extends SessionRecord>(
  rec: T,
  runRec: RunRecord,
  stream: Stream,
  { resolveExit, emit, cleanup, checkAlive }: {
    resolveExit: (info: ExitInfo) => void;
    emit: (rec: any) => void;
    cleanup?: () => void;
    // True for a reattached run: there is no 'exit' event, so poll for life.
    checkAlive: boolean;
  },
): DetachedRun {
  let done = false;
  let ticks = 0;

  const persist = (): void => {
    try {
      detached.writeRecord(runRec);
    } catch (e) {
      console.warn('[runner] could not save a detached run record:', (e as Error).message);
    }
  };

  // Handle every complete new line, then move the offsets past them. If a line
  // changed the task, db.json is written first, so a crash can never leave the
  // offset ahead of the task state it produced.
  const drain = (final: boolean): void => {
    const out = detached.readLines(runRec.stdoutPath, runRec.offset, final);
    const err = detached.readLines(runRec.stderrPath, runRec.errOffset, final);
    if (out.offset === runRec.offset && err.offset === runRec.errOffset) return;
    stream.st.dirty = false;
    for (const line of out.lines) stream.line(line);
    for (const line of err.lines) stream.errLine(line);
    if (stream.st.dirty) flush();
    runRec.offset = out.offset;
    runRec.errOffset = err.offset;
    persist();
  };

  const run: DetachedRun = {
    record: runRec,
    finish({ code, fallbackError }) {
      if (done) return;
      done = true;
      clearInterval(timer);
      try {
        drain(true);
      } catch (e) {
        console.warn('[runner] could not read the end of a detached run:', (e as Error).message);
      }
      if (running.get(rec.id)?.detached === run) running.delete(rec.id);
      if (cleanup) cleanup();
      // Deny any prompts still waiting — the child that asked is gone.
      permissions.rejectForTask(rec.id, 'Run ended');
      rec.finishedAt = now();
      rec.activeSubagents = 0;
      // The outcome comes from the stream (and a recorded stop), never from a
      // signal: after a restart there is no exit status to read, and the
      // attached path of a detached run must reach the same verdict.
      resolveExit({
        code,
        signal: null,
        stopped: !!runRec.stopped,
        sawResult: stream.st.sawResult,
        stderrTail: stream.st.stderrTail,
        fallbackError,
      });
      emit(rec);
      // Only forget the run once its final state is on disk; otherwise a crash
      // right here would leave a `running` task with no record (→ failed).
      try {
        flush();
      } catch (e) {
        console.warn('[runner] could not save db.json:', (e as Error).message);
      }
      detached.removeRun(runRec);
    },
    detach() {
      if (done) return;
      done = true;
      clearInterval(timer);
      persist();
      if (running.get(rec.id)?.detached === run) running.delete(rec.id);
    },
    markStopped() {
      runRec.stopped = true;
      persist();
    },
  };

  const timer = setInterval(() => {
    try {
      drain(false);
    } catch (e) {
      console.warn('[runner] could not read a detached run:', (e as Error).message);
    }
    if (checkAlive && ++ticks % ALIVE_EVERY === 0 && !detached.pidExists(runRec.pid)) {
      run.finish({ code: null, fallbackError: 'The run ended without a result (its exit code is unknown after a restart)' });
    }
  }, POLL_MS);
  // A detached run is meant to outlive this process; never hold it open.
  timer.unref();
  return run;
}

/**
 * The detached variant of launch() (Settings.detachedRuns, dispatch and Code
 * Review only — see docs/specs/detached-runner.md). The child gets its own
 * process group, reads its prompt from a file, and writes its output to files,
 * so it no longer needs this server to be alive. A record next to those files
 * lets a later server reattach to it (reattachAll).
 */
function launchDetached<T extends SessionRecord>(
  rec: T,
  opts: LaunchOpts,
  delivery: PromptDelivery | null,
  cleanupPrompt: () => void,
): T {
  const { adapter, args, workDir, prompt, emit, resolveExit, onResult, trackSession = true } = opts;
  const dir = detached.runDir(rec.id);
  const stdoutPath = path.join(dir, 'stdout.ndjson');
  const stderrPath = path.join(dir, 'stderr.log');
  // The prompt goes in as a file rather than a pipe: the child reads all of it
  // on its own time, so the server dying mid-write can't truncate it.
  const stdinPath = delivery ? null : path.join(dir, 'prompt.txt');

  const fds: number[] = [];
  let child: ChildProcess;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (stdinPath) fs.writeFileSync(stdinPath, prompt, { mode: 0o600 });
    const inFd = stdinPath ? fs.openSync(stdinPath, 'r') : null;
    if (inFd !== null) fds.push(inFd);
    const outFd = fs.openSync(stdoutPath, 'w', 0o600);
    fds.push(outFd);
    const errFd = fs.openSync(stderrPath, 'w', 0o600);
    fds.push(errFd);
    child = spawnCompat(adapter.bin, delivery ? [...args, ...delivery.args] : args, {
      cwd: workDir,
      env: adapter.childEnv(rec.model),
      stdio: [inFd === null ? 'ignore' : inFd, outFd, errFd],
      detached: true,
    });
  } catch (e) {
    cleanupPrompt();
    detached.removeRun({ dir, tempFiles: [] });
    throw e;
  } finally {
    // The child holds its own copies; ours are not needed.
    for (const fd of fds) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  child.unref();

  const pid = child.pid;
  const runRec: RunRecord = {
    taskId: rec.id,
    kind: opts.detach!.kind,
    agent: adapter.id,
    pid: pid ?? 0,
    startTime: pid ? detached.processStartTime(pid) : null,
    dir,
    stdinPath,
    stdoutPath,
    stderrPath,
    offset: 0,
    errOffset: 0,
    tempFiles: (delivery && delivery.tempFiles) || [],
    implementationSessionId: opts.detach!.implementationSessionId ?? null,
    stopped: false,
    startedAt: now(),
  };
  // No pid means the spawn failed ('error' follows); there is nothing to reattach to.
  if (pid) detached.writeRecord(runRec);

  const stream = streamInto(rec, adapter, emit, onResult, trackSession);
  const run = watchRun(rec, runRec, stream, { resolveExit, emit, cleanup: cleanupPrompt, checkAlive: false });
  const live: LiveRun = {
    pid,
    startedAt: runRec.startedAt,
    kill: (signal) => { if (pid) detached.killGroup(pid, signal || 'SIGTERM'); },
    detached: run,
  };
  running.set(rec.id, live);

  child.on('error', (err) => {
    run.detach();
    running.delete(rec.id);
    cleanupPrompt();
    detached.removeRun(runRec);
    failLaunch(rec, adapter, err, emit);
  });
  // While this server is still the parent it does see the exit; it then reads
  // what's left of the output and settles the run exactly as reattach would.
  child.on('exit', (code) => run.finish({ code }));

  return rec;
}

/**
 * Best-effort background memory distillation, kicked off after a task lands in
 * `validation` (see dispatch's resolveExit). A short, read-only Claude session
 * (see server/memory.ts) reviews what the task changed and folds any durable,
 * project-level learning into the repo's memory document. Everything here is
 * fire-and-forget: any guard below failing just means memory catches up on the
 * next task, never a queued retry.
 */
function maybeDistill(task: Task): void {
  if (!db.settings.memory) return;
  // `running` is already keyed by session id, and the distiller's id is scoped
  // to the repo (memory-<repoId>), so checking it here doubles as the "no
  // distill session already in flight for this repo" guard — with no separate
  // bookkeeping to leak if a spawn fails before ever reaching launch()'s own
  // exit handler.
  if (running.has(`memory-${task.repoId}`)) return;
  if (runningCount() >= db.settings.maxParallelSessions) return;
  try {
    distillMemory(task);
  } catch (e) {
    console.warn('[memory] failed to start distill session:', (e as Error).message);
  }
}

// Ephemeral: unlike dispatch/groom this session is never persisted to
// db.json — `emit` only broadcasts, it never save()s a task or grooming — and
// it always runs read-only in the task's own working directory so git diff/show
// can see what the task actually changed.
function distillMemory(task: Task): void {
  const rec: SessionRecord = {
    id: `memory-${task.repoId}`,
    status: 'running',
    model: memory.MEMORY_MODEL,
    sessionId: null,
    resolvedModel: null,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    activeSubagents: 0,
    lastOutcome: null,
    lastError: null,
    updatedAt: now(),
    finishedAt: null,
  };
  const prompt = memory.distillPrompt(memory.readMemory(task.repoId), task);

  launch(rec, {
    adapter: ClaudeAdapter,
    args: ClaudeAdapter.groomArgs({ model: memory.MEMORY_MODEL, sessionId: null }),
    workDir: task.worktreePath || task.repoPath,
    prompt,
    promptEvent: { type: 'prompt', text: prompt, memory: true },
    emit: () => {},
    onResult: (event) => usage.applyMemoryResult({
      id: rec.id,
      title: `Memory: ${task.title}`,
      repoId: task.repoId,
      repoName: task.repoName,
      model: rec.model,
      resolvedModel: rec.resolvedModel,
    }, event),
    resolveExit: ({ sawResult }) => {
      const updated = sawResult && !sawResult.isError ? memory.parseDistillResult(sawResult.text) : null;
      if (updated !== null) {
        memory.writeMemory(task.repoId, updated);
        broadcast({ type: 'memory', repoId: task.repoId, updatedAt: now() });
      }
    },
  });
}

/**
 * The Code Review stage: a FRESH, read-only reviewer session over the task's
 * branch (see server/reviewer.ts). It streams into the *same task card* as
 * another run of that task — same NDJSON log, same cost ledger, one more
 * `runCount` — but it is a different session with a different job, so:
 *   - `trackSession: false` keeps task.sessionId pointing at the implementing
 *     session (follow-ups and Autonomous Mode's review pass resume that one),
 *   - the args carry no `--resume`, no write tool and no permission bridge
 *     (see reviewArgs in server/agents/claude.ts), and
 *   - it always runs on Claude, like grooming and the queen do.
 *
 * However it ends, the card lands in `validation`: the implementation work
 * already succeeded and a human still has to validate it, so a failed, stopped
 * or unparsable review must never mark the task `failed`. On a parsed verdict the
 * grade is recorded on the task and stamped onto the PR as its `mergeable/<n>`
 * label (fire-and-forget — the label is a convenience, not the record).
 */
function codeReview(task: Task, pr: PrInfo): Task {
  if (running.has(task.id)) throw new Error('Task is already running');

  const adapter = ClaudeAdapter;
  // Restored in resolveExit: launch() must not leave the review's session id on
  // the task even though we let it stream through the same record.
  const implementationSessionId = task.sessionId;
  task.status = 'code_review';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  const prompt = reviewer.metaPrompt(task, pr);

  return launch(task, {
    adapter,
    args: claude.reviewArgs(task),
    workDir: task.worktreePath || task.repoPath,
    prompt,
    promptEvent: { type: 'prompt', text: prompt, codeReview: true, run: task.runCount },
    emit: emitTask,
    trackSession: false,
    onResult: (event) => usage.applyResult(task, event),
    resolveExit: codeReviewExit(task, implementationSessionId),
    detach: { kind: 'codeReview', implementationSessionId },
  });
}

// How a Code Review run settles the task. A factory rather than a closure in
// codeReview() so a server that restarted mid-review can rebuild it from the
// run record alone (see reattachAll).
function codeReviewExit(task: Task, implementationSessionId: string | null): (info: ExitInfo) => void {
  const adapter = ClaudeAdapter;
  return ({ code, signal, stopped, sawResult, stderrTail, fallbackError }) => {
    task.sessionId = implementationSessionId;
    // Whatever happened, the human validates from here — never `failed`.
    task.status = 'validation';
    if (signal || stopped) {
      task.lastOutcome = 'review-stopped';
      task.lastError = 'Code review stopped by user';
      record(task, { type: 'proc', text: 'Code review stopped by user — left in Validation' });
      return;
    }
    const succeeded = sawResult && !sawResult.isError;
    const verdict = succeeded ? reviewer.parseVerdict(sawResult.text) : null;
    if (verdict) {
      reviewer.applyVerdict(task, verdict);
      task.lastOutcome = 'reviewed';
      record(task, {
        type: 'proc',
        text: `Code review finished — mergeable ${verdict.grade}/5 (${reviewer.gradeMeaning(verdict.grade)})`,
      });
      // Best-effort: the grade lives on the task regardless of whether GitHub
      // accepted the label.
      github.setMergeableLabel(task, verdict.grade)
        .then((res) => {
          if (!res.ok) record(task, { type: 'proc', text: `Could not label the PR (${res.reason})` });
        })
        .catch((e) => console.warn('[reviewer] failed to label the PR:', (e as Error).message));
    } else if (succeeded) {
      task.lastOutcome = 'reviewed';
      record(task, { type: 'proc', text: 'Code review finished but produced no readable grade — left ungraded' });
    } else {
      task.lastOutcome = 'review-error';
      task.lastError =
        (sawResult && sawResult.errorReason) ||
        stderrTail.trim().split('\n').pop() ||
        fallbackError ||
        `${adapter.label} exited with code ${code}`;
      record(task, { type: 'proc', text: `Code review failed (${exitText(code)}): ${task.lastError}` });
    }
  };
}

/**
 * Best-effort auto-entry into the Code Review stage, kicked off right after a run
 * lands successfully (see dispatch's resolveExit, next to maybeDistill which it
 * is modeled on).
 *
 * This is OPT-IN per task (`task.autoCodeReview`, off by default): the stage costs
 * one extra short read-only session, so a task only flows into `code_review` when
 * it was configured to. Everything else — the flag off, no branch, no PR, a closed
 * PR, the parallel-session cap already reached, a `gh` lookup that failed — simply
 * leaves the task in `validation`, which is where it was already parked. Nothing
 * here is ever retried, and the manual `POST /api/tasks/:id/code-review` route
 * bypasses all of it (an explicit request always reviews).
 */
function maybeCodeReview(task: Task): void {
  if (!task.autoCodeReview) return; // not configured to be graded — validation it is
  if (!task.branch) return; // nothing to review against, and no PR to comment on
  if (running.has(task.id)) return;
  if (runningCount() >= db.settings.maxParallelSessions) {
    record(task, { type: 'proc', text: 'Skipped code review: max parallel sessions reached — left in Validation' });
    return;
  }
  github.prForTask(task)
    .then((found) => {
      if (!found.pr || found.pr.state !== 'open') {
        record(task, {
          type: 'proc',
          text: `Skipped code review: no open pull request for ${task.branch} (${found.pr ? found.pr.state : found.reason || 'no-pr'})`,
        });
        return;
      }
      // Re-check the gates: the lookup is async, so the world may have moved on.
      if (running.has(task.id) || task.status !== 'validation') return;
      if (runningCount() >= db.settings.maxParallelSessions) {
        record(task, { type: 'proc', text: 'Skipped code review: max parallel sessions reached — left in Validation' });
        return;
      }
      codeReview(task, found.pr);
    })
    .catch((e) => console.warn('[reviewer] failed to start the code review:', (e as Error).message));
}

/**
 * Dispatch a task: spawn its agent CLI in the task's working directory and
 * stream the NDJSON output into the task log + SSE bus. `prompt` is the text sent
 * on stdin; `resume` continues an existing session.
 */
function dispatch(task: Task, prompt: string, { resume = false }: { resume?: boolean } = {}): Task {
  if (running.has(task.id)) throw new Error('Task is already running');

  const adapter = adapterFor(task.agent);
  task.status = 'running';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  // Any implementation run invalidates the grade — a fresh one or a resume
  // (follow-up, review pass, conflict fix) can all change the branch, and the
  // verdict describes a diff that no longer exists. It comes back on the next
  // code review. (A code-review run doesn't go through dispatch, so its own
  // verdict is never cleared by this.)
  task.codeReview = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  return launch(task, {
    adapter,
    args: adapter.buildArgs(task, resume),
    workDir: task.worktreePath || task.repoPath,
    prompt,
    promptEvent: { type: 'prompt', text: prompt, resume, run: task.runCount },
    emit: emitTask,
    onResult: (event) => usage.applyResult(task, event),
    resolveExit: dispatchExit(task, adapter),
    detach: { kind: 'dispatch' },
  });
}

// How a dispatched run settles the task. A factory rather than a closure in
// dispatch() so a server that restarted mid-run can rebuild it from the run
// record alone (see reattachAll).
function dispatchExit(task: Task, adapter: AgentAdapter): (info: ExitInfo) => void {
  return ({ code, signal, stopped, sawResult, stderrTail, fallbackError }) => {
    if (signal || stopped) {
      task.status = 'ready';
      task.lastOutcome = 'stopped';
      task.lastError = 'Stopped by user';
      record(task, { type: 'proc', text: 'Run stopped by user' });
    } else if (sawResult && !sawResult.isError) {
      // The work landed: park it in `validation` for the human, then — only when
      // the task opted into grading and has an open PR — flow on into the Code
      // Review stage, which emits the `code_review` flip itself once its (async)
      // PR lookup comes back.
      task.status = 'validation';
      task.lastOutcome = 'success';
      record(task, { type: 'proc', text: `Run finished (${exitText(code)})` });
      maybeDistill(task);
      maybeCodeReview(task);
    } else {
      task.status = 'failed';
      task.lastOutcome = 'error';
      task.lastError =
        (sawResult && sawResult.errorReason) ||
        stderrTail.trim().split('\n').pop() ||
        fallbackError ||
        `${adapter.label} exited with code ${code}`;
      record(task, { type: 'proc', text: `Run failed (${exitText(code)}): ${task.lastError}` });
    }
  };
}

/**
 * Boot-time pickup of detached runs (docs/specs/detached-runner.md). Called once
 * by index.start() before the server listens — so a permission bridge retrying
 * through the restart finds its task live again. For each run record:
 *   - the lines the previous server already handled are replayed only to
 *     rebuild state (open subagents, a result already seen) — nothing is logged,
 *     billed or saved twice;
 *   - a process that is still alive (pid exists AND its start time matches) is
 *     put back in the live pool and tailed from the saved offset;
 *   - a process that is gone is finished from the rest of its output file: with
 *     a result event it lands exactly as a normal exit would (success branch,
 *     memory, Code Review hand-off), without one it fails with a clear line.
 * Runs regardless of Settings.detachedRuns: a record on disk describes a real
 * process that was started detached, whatever the setting says now.
 */
function reattachAll(): { reattached: string[]; finished: string[] } {
  const out = { reattached: [] as string[], finished: [] as string[] };
  for (const runRec of detached.listRecords()) {
    const task = getTask(runRec.taskId);
    if (!task || (task.status !== 'running' && task.status !== 'code_review') || running.has(task.id)) {
      // Nothing on the board owns this run any more (the task was settled after
      // its last save, or deleted). Never kill what we can't account for; just
      // stop tracking it.
      if (detached.isAlive(runRec.pid, runRec.startTime)) {
        console.warn(`[runner] a detached run (pid ${runRec.pid}) has no live task; leaving it alone`);
      }
      detached.removeRun(runRec);
      continue;
    }

    const isReview = runRec.kind === 'codeReview';
    const adapter = isReview ? ClaudeAdapter : adapterFor(runRec.agent || task.agent);
    const base = isReview
      ? codeReviewExit(task, runRec.implementationSessionId ?? null)
      : dispatchExit(task, adapter);
    const resolveExit = (info: ExitInfo): void => {
      base(info);
      // The conflict watcher (server/conflicts.ts) lived in the old process, so
      // nobody else will drop the "Resolving Conflicts" label once this lands.
      if (task.status !== 'running' && task.status !== 'code_review') task.resolvingConflicts = false;
    };

    const stream = streamInto(task, adapter, emitTask, (event) => usage.applyResult(task, event), !isReview);
    for (const line of detached.readHandled(runRec.stdoutPath, runRec.offset)) stream.replay(line);
    stream.st.stderrTail = detached.readTail(runRec.stderrPath, runRec.errOffset);
    task.activeSubagents = stream.st.openSubagents.size;

    const alive = detached.isAlive(runRec.pid, runRec.startTime);
    const run = watchRun(task, runRec, stream, { resolveExit, emit: emitTask, checkAlive: true });
    running.set(task.id, {
      pid: runRec.pid,
      startedAt: runRec.startedAt,
      // Only ever signal a process we just proved is ours.
      kill: (signal) => { if (alive) detached.killGroup(runRec.pid, signal || 'SIGTERM'); },
      detached: run,
    });

    if (alive) {
      record(task, { type: 'proc', text: 'Ployd restarted — reattached to the live run' });
      emitTask(task);
      out.reattached.push(task.id);
    } else {
      record(task, { type: 'proc', text: 'Ployd restarted — the run ended while it was down; reading its output' });
      run.finish({ code: null, fallbackError: 'The run ended while Ployd was not running, without a result' });
      out.finished.push(task.id);
    }
  }
  return out;
}

/**
 * Run a grooming card: a short, read-only agent session in the repo that thinks
 * the rough idea through and proposes one or more task specs. The card never
 * becomes a task itself — on success `onSpawn` creates the tasks and the card
 * lands in `finished` with links to them. The `running` status (like a task's)
 * is entered only here, never via the API. Grooming always runs against Claude.
 *
 * The session may instead ask the developer to clarify something (see groomer):
 * when it does, the card lands in `awaiting` with the questions kept on it and
 * its session id retained, so answering resumes the same session. Pass
 * `resumePrompt` to feed those answers back in and continue where it paused.
 */
function groom(
  grooming: Grooming,
  { onSpawn, resumePrompt }: { onSpawn: (specs: GroomSpec[]) => string[]; resumePrompt?: string },
): Grooming {
  if (running.has(grooming.id)) throw new Error('Grooming is already running');

  const adapter = ClaudeAdapter;
  const resume = typeof resumePrompt === 'string';
  grooming.status = 'running';
  grooming.startedAt = now();
  grooming.finishedAt = null;
  grooming.lastOutcome = null;
  grooming.lastError = null;
  // A fresh (non-resume) run starts the idea over — drop any stale questions/
  // session from a previous awaiting/failed pass.
  if (!resume) {
    grooming.questions = [];
    grooming.sessionId = null;
  }
  grooming.runCount = (grooming.runCount || 0) + 1;
  grooming.activeSubagents = 0;
  emitGrooming(grooming);

  const prompt = resume ? resumePrompt! : groomer.metaPrompt(grooming.idea, memory.readMemory(grooming.repoId));

  return launch(grooming, {
    adapter,
    args: adapter.groomArgs(grooming, resume),
    workDir: grooming.repoPath, // grooming is read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, groom: true, resume, run: grooming.runCount },
    emit: emitGrooming,
    onResult: (event) => usage.applyGroomResult(grooming, event),
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      if (signal || stopped) {
        // Park a stopped grooming back in draft with the rough idea intact. Drop
        // the session — a fresh run starts over.
        grooming.sessionId = null;
        grooming.questions = [];
        grooming.status = 'draft';
        grooming.lastOutcome = 'stopped';
        grooming.lastError = 'Grooming stopped by user';
        record(grooming, { type: 'proc', text: 'Grooming stopped by user' });
        return;
      }
      const succeeded = sawResult && !sawResult.isError;
      const resultText = succeeded ? sawResult.text : '';

      // First check whether the session paused to ask the developer to clarify.
      const questions = succeeded ? groomer.parseQuestions(resultText) : null;
      if (questions) {
        // Keep the session id (set from the init event) so answering resumes it.
        grooming.questions = questions;
        grooming.status = 'awaiting';
        grooming.lastOutcome = 'awaiting';
        grooming.lastError = null;
        grooming.finishedAt = null; // paused, not finished (launch set it on exit)
        record(grooming, {
          type: 'proc',
          text: `Grooming needs input — asked ${questions.length} question${questions.length === 1 ? '' : 's'}`,
        });
        return;
      }

      // Otherwise the turn is terminal — it either produced a spec or failed.
      // Drop the session id so nothing on a finished/failed card points at it.
      grooming.sessionId = null;
      grooming.questions = [];

      let specs = succeeded ? groomer.parseResult(resultText) : null;
      if (!specs && succeeded && resultText.trim()) {
        // Session finished but we couldn't parse a structured spec — keep the
        // full text as one task prompt so nothing is lost (never auto-ready).
        specs = [{ title: grooming.title, prompt: resultText.trim(), ready: false, complexity: 'standard' }];
        record(grooming, { type: 'proc', text: 'Kept unstructured output as a single task prompt' });
      }
      if (specs) {
        grooming.taskIds = onSpawn(specs);
        grooming.status = 'finished';
        grooming.lastOutcome = 'groomed';
        record(grooming, {
          type: 'proc',
          text: `Groomed the idea into ${grooming.taskIds.length} task${grooming.taskIds.length === 1 ? '' : 's'}`,
        });
      } else {
        grooming.status = 'failed';
        grooming.lastOutcome = 'error';
        grooming.lastError =
          (sawResult && sawResult.errorReason) ||
          stderrTail.trim().split('\n').pop() ||
          `${adapter.label} exited with code ${code}`;
        record(grooming, { type: 'proc', text: `Grooming failed (exit ${code}): ${grooming.lastError}` });
      }
    },
  });
}

/**
 * Run one turn of a goal orchestration's orchestrator session: a read-only Claude
 * session that plans the goal and drives the board through Ployd's own MCP
 * server (see orchestrateArgs in server/agents/claude.ts — research tools plus
 * the board tools, never a write tool and never a worktree).
 *
 * Every turn must end with one status object between the ORCH sentinels (see
 * server/orchestrator.ts), which decides where the card lands:
 *   waiting  → `waiting`, with the watched task ids kept on the card so the
 *              orchestrator engine (server/orchestrator-engine.ts) can resume this
 *              same session when they land
 *   question → `awaiting`, paused on a question for the developer
 *   done     → `finished`
 *   blocked  → `failed`
 * `waiting` and `awaiting` keep the sessionId (they are resumable, and survive a
 * server restart); the terminal states drop it. Pass `resumePrompt` to continue
 * the session — the engine's status update, or the developer's answer.
 */
function orchestrate(
  orchestration: Orchestration,
  { resumePrompt }: { resumePrompt?: string } = {},
): Orchestration {
  if (running.has(orchestration.id)) throw new Error('Orchestration is already running');

  const adapter = ClaudeAdapter;
  const resume = typeof resumePrompt === 'string';
  orchestration.status = 'running';
  orchestration.startedAt = orchestration.startedAt && resume ? orchestration.startedAt : now();
  orchestration.finishedAt = null;
  orchestration.lastOutcome = null;
  orchestration.lastError = null;
  // A fresh (non-resume) run starts the goal over — drop the previous session and
  // whatever it was watching.
  if (!resume) {
    orchestration.sessionId = null;
    orchestration.watch = [];
    orchestration.note = null;
    // The turn cap (orchestratorEngine.MAX_TURNS) counts turns of ONE orchestrator
    // session, so a fresh run of the goal starts the count over.
    orchestration.turnCount = 0;
  }
  orchestration.runCount = (orchestration.runCount || 0) + 1;
  orchestration.turnCount = (orchestration.turnCount || 0) + 1;
  orchestration.activeSubagents = 0;
  emitOrchestration(orchestration);

  const prompt = resume
    ? resumePrompt!
    : orchestrator.metaPrompt(orchestration, memory.readMemory(orchestration.repoId));

  return launch(orchestration, {
    adapter,
    args: claude.orchestrateArgs(orchestration, resume),
    workDir: orchestration.repoPath, // planning is read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, orchestrate: true, resume, run: orchestration.runCount },
    emit: emitOrchestration,
    onResult: (event) => usage.applyOrchestrationResult(orchestration, event),
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      if (signal || stopped) {
        // Park a stopped orchestration back in draft with the goal intact. The
        // session goes with it — a fresh run re-plans from scratch (mirrors how
        // a stopped grooming card is parked).
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'draft';
        orchestration.lastOutcome = 'stopped';
        orchestration.lastError = 'Orchestration stopped by user';
        record(orchestration, { type: 'proc', text: 'Orchestration stopped by user' });
        return;
      }
      const succeeded = sawResult && !sawResult.isError;
      const status = succeeded ? orchestrator.parseStatus(sawResult.text) : null;
      if (!status) {
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'failed';
        orchestration.lastOutcome = 'error';
        orchestration.lastError = succeeded
          ? 'The orchestrator ended its turn without a valid status update'
          : (sawResult && sawResult.errorReason) ||
            stderrTail.trim().split('\n').pop() ||
            `${adapter.label} exited with code ${code}`;
        record(orchestration, { type: 'proc', text: `Orchestration failed (exit ${code}): ${orchestration.lastError}` });
        return;
      }

      orchestration.note = status.note || null;
      if (status.state === 'waiting') {
        // Still going: keep the session (the engine resumes it) and remember the
        // workers this turn asked for, both as the live watch set and on the
        // running roster of every task this orchestration has touched.
        orchestration.watch = status.watch;
        orchestration.taskIds = [...new Set([...(orchestration.taskIds || []), ...status.watch])];
        orchestration.status = 'waiting';
        orchestration.lastOutcome = 'waiting';
        orchestration.finishedAt = null; // paused between turns, not finished
        record(orchestration, {
          type: 'proc',
          text: `Waiting on ${status.watch.length} task${status.watch.length === 1 ? '' : 's'}${status.note ? `: ${status.note}` : ''}`,
        });
      } else if (status.state === 'question') {
        orchestration.watch = [];
        orchestration.status = 'awaiting';
        orchestration.lastOutcome = 'awaiting';
        orchestration.finishedAt = null;
        record(orchestration, { type: 'proc', text: `Orchestration needs input: ${status.note}` });
      } else if (status.state === 'done') {
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'finished';
        orchestration.lastOutcome = 'orchestrated';
        record(orchestration, { type: 'proc', text: `Goal complete: ${status.note}` });
      } else {
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'failed';
        orchestration.lastOutcome = 'blocked';
        orchestration.lastError = status.note || 'The orchestrator reported it is blocked';
        record(orchestration, { type: 'proc', text: `Orchestration blocked: ${orchestration.lastError}` });
      }
    },
  });
}

/**
 * Run a short, read-only "Ask Ployd" Q&A session in a repo. Unlike
 * dispatch/groom, the session is ephemeral: `session` is a plain in-memory
 * record (never a Task/Grooming, never persisted), so it drives the same
 * launch() plumbing but its `emit` only broadcasts — nothing is ever
 * store.save()'d. It still runs through the shared `running` map, so it
 * counts against maxParallelSessions and is stoppable via runner.stop like
 * any other session. Always Claude, read-only (same allow-list as grooming),
 * and never a worktree — see server/ask.ts for the prompt itself.
 */
function ask(session: AskSession, question: string, projectMemory: string | null): AskSession {
  if (running.has(session.id)) throw new Error('Ask session is already running');

  const adapter = ClaudeAdapter;
  session.status = 'running';

  const prompt = askPrompt(question, projectMemory);

  return launch(session, {
    adapter,
    args: adapter.groomArgs(session, false),
    workDir: session.repoPath, // read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, ask: true },
    emit: (rec: AskSession) => {
      rec.updatedAt = now();
      broadcast({ type: 'ask-update', askId: rec.id, repoId: rec.repoId, sessionId: rec.sessionId, activeSubagents: rec.activeSubagents, costUsd: rec.costUsd });
    },
    onResult: (event) => usage.applyAskResult({
      id: session.id,
      title: session.question,
      repoId: session.repoId,
      repoName: session.repoName,
      model: session.model,
      resolvedModel: session.resolvedModel,
    }, event),
    resolveExit: ({ signal, stopped, sawResult, stderrTail }) => {
      const ok = !!(sawResult && !sawResult.isError) && !signal && !stopped;
      let answer: string;
      if (stopped || signal) {
        answer = 'Stopped by user';
      } else if (ok) {
        answer = (sawResult && sawResult.text) || '';
      } else {
        answer = (sawResult && sawResult.errorReason) || stderrTail.trim().split('\n').pop() || `${adapter.label} failed`;
      }
      session.status = ok ? 'done' : 'failed';
      broadcast({ type: 'ask', askId: session.id, repoId: session.repoId, ok, answer, costUsd: session.costUsd });
    },
  });
}

// Stop a live run. For a detached run kill() signals its whole process group —
// the agent and everything it started — and works the same before and after a
// restart, since it needs only the pid; the stop is also written to the run
// record, so one that lands just before a restart is still a stop.
function stop(taskId: string): boolean {
  const child = running.get(taskId);
  if (!child) return false;
  child.wasStopped = true;
  if (child.detached) child.detached.markStopped();
  child.kill('SIGTERM');
  setTimeout(() => {
    if (running.get(taskId) === child) child.kill('SIGKILL');
  }, 5000);
  return true;
}

function stopAll(): void {
  for (const [taskId] of running) stop(taskId);
}

/**
 * The server is going away (Electron quit — including relaunching into an
 * update — or the dev server's SIGINT). With Settings.detachedRuns on, detached
 * runs are left running and only stop being watched: their offsets are already
 * on disk, and the next boot reattaches them. Everything attached is stopped as
 * before. With the setting off this is stopAll(), except that a detached run
 * left over from when it was on is not recorded as a user stop — the next boot
 * then fails it, which is exactly what a quit did before.
 */
function shutdown(): void {
  const keepDetached = detachedEnabled();
  for (const [taskId, child] of [...running]) {
    if (child.detached) {
      child.detached.detach();
      if (!keepDetached) child.kill('SIGTERM');
      continue;
    }
    stop(taskId);
  }
}

// Set the server base URL for the Claude permission bridge (the only backend
// that POSTs approvals back). Called once the port is known (see index.start).
function setBaseUrl(url: string): void {
  claude.setBaseUrl(url);
}

export {
  dispatch,
  codeReview,
  maybeCodeReview,
  groom,
  orchestrate,
  ask,
  stop,
  stopAll,
  shutdown,
  reattachAll,
  detachedEnabled,
  isRunning,
  runningCount,
  liveChildren,
  adapterFor,
  setBaseUrl,
};

// Claude-specific helpers re-exported for the REST/MCP layers and the smoke
// suite, which expect them on `runner` (their behavior is unchanged; the
// implementation now lives in server/agents/claude.ts).
export const {
  buildArgs,
  buildTaskEnv,
  memoryEnv,
  sessionMemoryMb,
  autoSessionMemoryMb,
  mcpIsolationArgs,
  childEnv,
  normalizeAllowedTools,
  mergeAllowedTools,
  effectiveAllowedTools,
  PERMISSION_TOOL,
  DEFAULT_ALLOWED_TOOLS,
  CLAUDE_BIN,
  resolvedBaseUrl,
} = claude;

// The non-Claude binaries, for the health probe (GET /api/health checks every backend).
export const { CODEX_BIN } = codex;
export const { GROK_BIN } = grok;

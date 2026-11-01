/*
 * Detached runs: the on-disk side of a task run that outlives the server (see
 * docs/specs/detached-runner.md). Everything here is plain file and process
 * plumbing — the run record, liveness, group kill and offset tailing. The
 * runner (server/runner.ts) owns what the lines MEAN; this module never parses
 * an agent's stream.
 *
 * A detached run lives in its own folder under PLOYD_DATA_DIR/runs/:
 *   run.json      the record (pid, start time, file paths, read offsets)
 *   prompt.txt    the child's stdin, when the backend reads its prompt there
 *   stdout.ndjson the child's stdout (the agent's JSON stream)
 *   stderr.log    the child's stderr
 * Files, not pipes: a pipe to a dead parent hands the child SIGPIPE, a file has
 * no reader to lose. The folder is removed once the run is finished.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { RUNS_DIR } from './store';
import type { TaskAgent } from './types';

export type RunKind = 'dispatch' | 'codeReview';

export interface RunRecord {
  taskId: string;
  kind: RunKind;
  agent: TaskAgent;
  pid: number;
  // `ps -o lstart=` of the process when it was spawned. Compared on reattach so
  // a reused pid is never mistaken for our run. null when ps could not answer,
  // which reattach treats as "gone" (the safe side).
  startTime: string | null;
  dir: string;
  stdinPath: string | null;
  stdoutPath: string;
  stderrPath: string;
  // Bytes of stdout / stderr the server has already handled. Everything before
  // these is never parsed for effect again.
  offset: number;
  errOffset: number;
  // Files to delete once the run ends (Grok's temp prompt file).
  tempFiles: string[];
  // Code Review only: the implementing session id to restore on the task.
  implementationSessionId?: string | null;
  // Set when the user stops the run, so a stop just before a restart is still a stop.
  stopped?: boolean;
  startedAt: string;
}

const RECORD_FILE = 'run.json';

// Detached process groups (and signalling one with a negative pid) are POSIX.
// On Windows `detached` means "new console" and there is no group to kill, so
// runs stay attached there even with the setting on.
function supported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

function runDir(taskId: string): string {
  // One folder per run (a task can finish a run and start its code review in
  // the same tick), so a finishing run only ever removes its own files.
  return path.join(RUNS_DIR, `${taskId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
}

function writeRecord(rec: RunRecord): void {
  const file = path.join(rec.dir, RECORD_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Every readable run record on disk. A folder whose record is missing or
// corrupt is not trustworthy to act on, so it is removed and skipped — its task
// falls back to the old "orphaned running task" rule.
function listRecords(): RunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(RUNS_DIR);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const name of names) {
    const dir = path.join(RUNS_DIR, name);
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8')) as RunRecord;
      if (!rec || typeof rec.taskId !== 'string' || typeof rec.pid !== 'number') throw new Error('bad record');
      rec.dir = dir; // trust the folder we found it in, not the path it claims
      out.push(rec);
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return out;
}

function removeRun(rec: Pick<RunRecord, 'dir' | 'tempFiles'>): void {
  for (const f of rec.tempFiles || []) {
    try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
  }
  try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// The process start time as `ps` prints it, or null if there is no such
// process (or ps could not be run). Constant for the life of a process —
// including across exec — so it pins a pid to one process.
function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Does a process with this pid exist? EPERM means it exists but isn't ours to
// signal, which still counts as alive.
function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Is the process the record describes still running? Both halves must hold:
// the pid exists, and it is the same process (its start time matches).
function isAlive(pid: number, startTime: string | null): boolean {
  if (!startTime || !pidExists(pid)) return false;
  return processStartTime(pid) === startTime;
}

// Signal a detached run's whole process group (the agent plus everything it
// started), falling back to the pid alone if the group is already gone.
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

// Read the complete lines in `file` after byte `offset`. Returns them with the
// offset just past the last newline, so an incomplete trailing line is left
// for the next read. `final` (the writer is gone) takes that last line too.
// Splitting on the newline byte is safe for UTF-8: 0x0A never occurs inside a
// multi-byte sequence.
function readLines(file: string, offset: number, final = false): { lines: string[]; offset: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { lines: [], offset };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset };
    const buf = Buffer.alloc(size - offset);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const chunk = buf.subarray(0, read);
    const lastNl = chunk.lastIndexOf(0x0a);
    const end = final ? chunk.length : lastNl + 1;
    if (end <= 0) return { lines: [], offset };
    const lines = chunk.subarray(0, end).toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines, offset: offset + end };
  } finally {
    fs.closeSync(fd);
  }
}

// The lines in bytes [0, upTo) of `file` — the part a previous server already
// handled. Reattach replays them only to rebuild state, never for effect.
function readHandled(file: string, upTo: number): string[] {
  if (upTo <= 0) return [];
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(upTo);
      const n = fs.readSync(fd, buf, 0, upTo, 0);
      const lines = buf.subarray(0, n).toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

// The last `max` characters of `file` up to byte `upTo` — to rebuild a run's
// stderr tail (used in failure messages) after a restart.
function readTail(file: string, upTo: number, max = 4000): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, upTo - max * 4);
      const buf = Buffer.alloc(Math.max(0, upTo - start));
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').slice(-max);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export {
  RUNS_DIR,
  supported,
  runDir,
  writeRecord,
  listRecords,
  removeRun,
  processStartTime,
  pidExists,
  isAlive,
  killGroup,
  readLines,
  readHandled,
  readTail,
};

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SessionAgent } from './types';

// User-defined agent commands for in-app terminal sessions (Settings → General
// → Session agents): `aider`, `opencode`, `gemini`, `claude --model opus`, …
// The new-session picker lists them after the built-in Claude/Codex/Grok kinds,
// and a session started with one types its command at a fresh shell prompt,
// exactly like the built-ins do (see server/terminal.ts).
//
// The security rule is the Run button's: the board sends an agent's *id*, never
// a command. `find` is the only way from a request to a command line, and it
// only ever returns what the user saved in Settings — keep it a lookup.
//
// Interactive sessions only. Nothing here touches the task pipeline or the
// agent adapters in server/agents/.

const MAX_AGENTS = 20;
const MAX_ID = 32;
const MAX_LABEL = 40;
const MAX_COMMAND = 500;
// A short lowercase slug: letters, digits and inner dashes.
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Any C0 control (newline, carriage return, tab, ESC, …), DEL, or C1 control.
// The command is typed at a live shell prompt, so a newline would run a second
// command and an escape sequence would drive the terminal itself.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function isSlug(v: string): boolean {
  return v.length <= MAX_ID && ID_RE.test(v);
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ID - 3)
    .replace(/-+$/, '');
}

// A free id derived from `seed`: the seed itself, else `seed-2`, `seed-3`, …
function freeId(seed: string, seen: Set<string>): string {
  const base = seed || 'agent';
  if (!seen.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!seen.has(candidate)) return candidate;
  }
}

// Coerces the board's list into clean, storable entries — the same contract as
// custom models: malformed rows are dropped rather than trusted, and an id is
// kept when the board round-trips a valid unused one, minted from the label
// otherwise (so renaming an agent doesn't change its id, and a brand-new row
// doesn't need one). A row survives only with a non-empty label of at most
// MAX_LABEL characters and a single-line command of at most MAX_COMMAND with no
// control characters.
function sanitize(value: unknown): SessionAgent[] {
  if (!Array.isArray(value)) return [];
  const out: SessionAgent[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_AGENTS) break;
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.label !== 'string' || typeof entry.command !== 'string') continue;
    const label = entry.label.trim();
    const command = entry.command.trim();
    if (!label || label.length > MAX_LABEL || CONTROL_RE.test(label)) continue;
    if (!command || command.length > MAX_COMMAND || CONTROL_RE.test(command)) continue;
    const given = typeof entry.id === 'string' ? entry.id.trim() : '';
    const aid = isSlug(given) && !seen.has(given) ? given : freeId(slugify(label), seen);
    seen.add(aid);
    out.push({ id: aid, label, command });
  }
  return out;
}

// The saved agent with this id, or undefined. Never anything else: an unknown
// id, a non-string, or a command string is simply not found.
function find(list: SessionAgent[] | undefined, agentId: unknown): SessionAgent | undefined {
  if (typeof agentId !== 'string' || !agentId) return undefined;
  return (list || []).find((a) => a.id === agentId);
}

// The program a command line starts: its first word, skipping leading
// `NAME=value` environment assignments and one layer of quotes. Best effort —
// it only feeds the "found on PATH" hint, never what runs.
function programOf(command: string): string | null {
  const words = command.trim().split(/\s+/);
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    const bare = w.replace(/^(['"])(.*)\1$/, '$2');
    return bare || null;
  }
  return null;
}

// Windows launchers are `aider.exe` / `opencode.cmd`, so try each PATHEXT suffix.
function binNames(bin: string): string[] {
  if (process.platform !== 'win32') return [bin];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [bin, ...exts.map((e) => bin + e.toLowerCase())];
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Whether a command's program exists on this machine: an explicit path is
// checked directly (`~/` expanded), a bare name is searched on PATH. Only a
// filesystem lookup — nothing is executed, unlike /api/health's `--version`
// probe, which is fine for three known CLIs but not for arbitrary user
// commands. A shell alias or function can't be seen from here, so "not found"
// is a hint, not a verdict: the picker still offers the agent.
function found(command: string): boolean {
  const prog = programOf(command);
  if (!prog) return false;
  if (prog.includes('/') || (process.platform === 'win32' && prog.includes('\\'))) {
    const file = prog.startsWith('~/') ? path.join(os.homedir(), prog.slice(2)) : prog;
    return binNames(file).some(executable);
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => binNames(prog).some((name) => executable(path.join(dir, name))));
}

// id -> found on PATH, for every saved agent. Derived on each read (a handful
// of stat calls), never stored.
function availability(list: SessionAgent[] | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of list || []) out[a.id] = found(a.command);
  return out;
}

export { sanitize, find, programOf, found, availability, MAX_AGENTS, MAX_LABEL, MAX_COMMAND };

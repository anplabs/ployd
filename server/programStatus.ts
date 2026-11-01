/*
 * OSC 7501, the Program Status Protocol, for the in-app terminal sessions.
 *
 * Spec (revision 0.4): https://www.superlogical.com/rex/docs/build/program-status
 *
 * A program running in a terminal can say what it is doing with an escape
 * sequence: `ESC ] 7501 ; state=working:app=claude-code ST`, where ST is
 * `ESC \` or BEL. The states are idle, working, done, blocked (waiting on the
 * user) and error; `clear` removes the record. Claude Code (2.1.295+) and the
 * Codex CLI (0.163.0+) both send it, so a session no longer has to guess from
 * silence whether the agent inside it is busy.
 *
 * This module is pure: a chunk parser plus the rules that turn what it finds
 * into a session's status. server/terminal.ts feeds it the pty output and owns
 * the side effects (the query reply, the bus broadcast). The output itself is
 * passed through untouched: xterm.js ignores an OSC it doesn't know, so the
 * replay and the rendering are unaffected.
 *
 * Only the root record (a report with no `id`) drives the status. Programs that
 * report on several things at once (`id=us-east`, ...) are valid, but a session
 * has one bullet, and the root record is the program's own word for itself.
 */

type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';

interface StatusReport {
  state: ProgramState | 'clear';
  // '' for the root record.
  id: string;
  app: string;
  // Only on `blocked`, when the program said why.
  kind?: 'permission' | 'question' | 'auth';
}

type StatusEvent =
  | { type: 'report'; report: StatusReport }
  // `OSC 7501 ; ? ST`: the program asks whether this terminal speaks 7501.
  | { type: 'query' }
  // `OSC 133 ; A`: shell integration says a new prompt began.
  | { type: 'prompt' }
  // `ESC c` (RIS): a full reset, which the spec says removes every record.
  | { type: 'reset' };

// What a session remembers of the root record.
interface Reported {
  state: ProgramState;
  app: string;
}

// The slice of a terminal session these rules read and write.
interface Tracked {
  reported: Reported | null;
}

// The feature-detection reply. Claude Code asks before it reports anything
// (`OSC 7501 ; ? BEL`, then `CSI c`) and stays silent unless the 7501 answer
// arrives before the device-attributes one, so the server must answer it.
// Fixed text with no newline: it can't run anything even if a stray `cat`
// triggers it at a bare prompt.
const QUERY_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

// Spec limits. A sequence longer than this is dropped whole.
const MAX_SEQUENCE = 4096;
const MAX_KEY = 16;
const MAX_APP = 32;
const MAX_ID = 128;
const MAX_MSG = 2732;
const MAX_TITLE = 256;

// A reported `working` is trusted over silence, but not forever: an agent that
// crashed mid-turn (no `clear`) would otherwise leave a dead prompt green. Every
// agent TUI that reports redraws a spinner while it works, so ten minutes with
// no output at all means it is gone, not thinking.
const STALE_WORKING_MS = 10 * 60_000;

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const KINDS = new Set(['permission', 'question', 'auth']);
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;

// Base64 text fields (`msg`, `title`): the spec drops the whole report when one
// doesn't decode, or decodes to something with a control character in it.
function validText(v: string, max: number): boolean {
  if (v.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length % 4 === 1) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(Buffer.from(v, 'base64').toString('utf8'));
}

// `pairs` from `OSC 7501 ; pairs ST`. Null when the spec says to ignore the
// report: no or unknown state, an invalid id, or invalid free text.
function parseReport(payload: string): StatusReport | null {
  const pairs = new Map<string, string>();
  for (const raw of payload.split(':')) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue; // malformed pairs are skipped, the rest still counts
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!/^[a-z]+$/.test(key) || key.length > MAX_KEY || !VALUE.test(value)) continue;
    pairs.set(key, value); // a repeated key: the last one wins
  }
  const state = pairs.get('state');
  if (!state || !STATES.has(state)) return null;
  const id = pairs.get('id') || '';
  if (id) {
    const segments = id.split('/');
    if (id.length > MAX_ID || segments.length > 8 || !segments.every((s) => ID_SEGMENT.test(s))) return null;
  }
  const msg = pairs.get('msg');
  const title = pairs.get('title');
  if (msg !== undefined && !validText(msg, MAX_MSG)) return null;
  if (title !== undefined && !validText(title, MAX_TITLE)) return null;
  const app = pairs.get('app') || '';
  const kind = pairs.get('kind');
  const report: StatusReport = {
    state: state as StatusReport['state'],
    id,
    app: app.length <= MAX_APP ? app : '', // an invalid app is treated as absent
  };
  if (state === 'blocked' && kind && KINDS.has(kind)) report.kind = kind as StatusReport['kind'];
  return report;
}

// The OSC bodies worth holding on to across a chunk boundary.
const PREFIXES = ['7501;', '133;'];

function interesting(body: string, complete: boolean): boolean {
  return PREFIXES.some((p) => (complete || body.length >= p.length ? body.startsWith(p) : p.startsWith(body)));
}

// Finds 7501 reports (and the two lifetime events the spec ties records to)
// in a stream of pty output. A pty read can end anywhere, so a sequence cut in
// two is carried over and finished by the next chunk. Everything else in the
// stream is skipped, never altered.
class StatusParser {
  // An unfinished sequence of interest from the previous chunk (latin1, so one
  // char per byte), at most MAX_SEQUENCE long.
  private carry = '';

  feed(chunk: Buffer | string): StatusEvent[] {
    const text = this.carry + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
    this.carry = '';
    const events: StatusEvent[] = [];
    let i = 0;
    while ((i = text.indexOf('\x1b', i)) !== -1) {
      if (i + 1 >= text.length) { this.carry = text.slice(i); break; }
      const next = text[i + 1];
      if (next === 'c') { events.push({ type: 'reset' }); i += 2; continue; }
      if (next !== ']') { i += 1; continue; }
      const start = i + 2;
      // Find the terminator: BEL, or ESC \. CAN/SUB or any other ESC cancel it.
      let j = start;
      while (j < text.length && !'\x07\x1b\x18\x1a'.includes(text[j])) j++;
      const body = text.slice(start, j);
      if (!interesting(body, j < text.length)) { i = start; continue; }
      if (j >= text.length || (text[j] === '\x1b' && j + 1 >= text.length)) {
        // Cut off mid-sequence: keep it for the next chunk, unless it is already
        // past the limit, in which case the whole report is dropped.
        if (text.length - i <= MAX_SEQUENCE) this.carry = text.slice(i);
        break;
      }
      const ended = text[j] === '\x07' || (text[j] === '\x1b' && text[j + 1] === '\\');
      if (!ended) { i = j; continue; } // cancelled; rescan from the char that ended it
      const end = text[j] === '\x07' ? j + 1 : j + 2;
      if (end - i <= MAX_SEQUENCE) {
        const event = eventFor(body);
        if (event) events.push(event);
      }
      i = end;
    }
    return events;
  }
}

function eventFor(body: string): StatusEvent | null {
  if (body.startsWith('133;')) {
    // OSC 133 ; A [; options]: prompt start. B/C/D are the other marks.
    return /^133;A(;|$)/.test(body) ? { type: 'prompt' } : null;
  }
  const payload = body.slice('7501;'.length);
  // Exactly `?`. A reply (`?:states=...`) echoed back must not ask again.
  if (payload.trim() === '?') return { type: 'query' };
  const report = parseReport(payload);
  return report ? { type: 'report', report } : null;
}

// Applies one event to a session's reported state. Records are replaced whole
// by each report, `clear` and a full reset remove them, and a new shell prompt
// ends `working`, `blocked` and `idle` ones (the agent is gone; `done` and
// `error` survive it, as the spec says, until the user acts — see onInput).
function applyEvent(t: Tracked, e: StatusEvent): void {
  if (e.type === 'reset') { t.reported = null; return; }
  if (e.type === 'prompt') {
    if (t.reported && t.reported.state !== 'done' && t.reported.state !== 'error') t.reported = null;
    return;
  }
  if (e.type !== 'report' || e.report.id) return; // child records don't drive the bullet
  const { state, app } = e.report;
  t.reported = state === 'clear' ? null : { state, app };
}

// The user submitted a line (Enter) into the session. A reported state other
// than `working` ends there: the agent will report `working` the moment it
// takes the line, and if nothing reports at all — the agent crashed after its
// last `done`, and this is now a plain shell — the silence timer takes back
// over instead of the tab staying amber while a build scrolls by. Plain
// keystrokes don't count, so the focus reports xterm sends on a tab switch
// (`ESC [ I`) leave a finished agent amber. `working` is left alone: typing
// ahead while an agent works doesn't mean it stopped.
function onInput(t: Tracked, data: string): void {
  if (t.reported && t.reported.state !== 'working' && /[\r\n]/.test(data)) t.reported = null;
}

// The bullet for a live session that has a reported state: working is
// `active`, everything else (idle, done, blocked, error) is `idle` — it is
// waiting for you. `quietMs` is how long the session has been silent; it only
// matters for the stale-`working` cutoff above.
function reportedStatus(r: Reported, quietMs: number): 'active' | 'idle' {
  return r.state === 'working' && quietMs <= STALE_WORKING_MS ? 'active' : 'idle';
}

export { StatusParser, parseReport, applyEvent, onInput, reportedStatus, QUERY_REPLY, STALE_WORKING_MS, MAX_SEQUENCE };
export type { ProgramState, StatusReport, StatusEvent, Reported, Tracked };

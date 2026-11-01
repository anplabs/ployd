#!/usr/bin/env node
'use strict';
/*
 * Ployd permission-prompt bridge — a tiny MCP stdio server.
 *
 * `claude` is pointed at this process via `--permission-prompt-tool mcp__ployd__approve`
 * (registered through `--mcp-config`, see runner.js). Whenever the CLI needs to ask
 * before running a tool, it calls our `approve` tool with `{ tool_name, input }`.
 * We forward that to the Ployd server (`PLOYD_APPROVAL_URL`), which surfaces it
 * as a prompt on the board and blocks until the user decides, then we hand the
 * decision back to the CLI as the tool result:
 *   { behavior: 'allow', updatedInput?: object } | { behavior: 'deny', message: string }
 *
 * MCP stdio transport is newline-delimited JSON-RPC 2.0. No dependencies — this is
 * intentionally hand-rolled to keep Ployd dependency-light. Kept pure enough to
 * unit-test: `respond(msg, ask)` builds a reply (or null for a notification) and
 * takes an injectable `ask` so tests never touch the network.
 */
const http = require('http');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_NAME = 'approve';
const TOOL_DEF = {
  name: TOOL_NAME,
  description:
    'Ask the Ployd user to approve or deny a tool call. Returns their decision; ' +
    'the user answers in the board UI. Do not call this yourself — the CLI invokes it.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool the assistant wants to run.' },
      input: { type: 'object', additionalProperties: true, description: 'The proposed tool input.' },
    },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
};

// A safe fallback decision so a broken bridge never hangs or silently allows.
function denied(message) {
  return { behavior: 'deny', message };
}

// How long a prompt may wait for the server to come back — the same as the
// server's own unanswered-prompt deny timeout (server/permissions.ts).
const RETRY_WINDOW_MS = 30 * 60 * 1000;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 10 * 1000;
// The errors that mean "the server isn't there right now" (restarting, or the
// connection dropped with it) rather than "the server said no".
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);

// One POST. Resolves { decision } on an answer, or { retry, message } on failure.
function postOnce(url, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && (parsed.behavior === 'allow' || parsed.behavior === 'deny')) resolve({ decision: parsed });
            else resolve({ decision: denied('Malformed approval response') });
          } catch { resolve({ decision: denied('Unreadable approval response') }); }
        });
        // The server died mid-reply.
        res.on('aborted', () => resolve({ retry: true, message: 'Approval request failed' }));
      },
    );
    req.on('error', (err) => resolve({ retry: RETRYABLE.has(err && err.code), message: 'Approval request failed' }));
    req.write(body);
    req.end();
  });
}

// POST the request to the Ployd server and resolve with its decision. Any
// failure denies rather than throwing, so the CLI always gets a valid answer.
//
// The server may be restarting (a detached run outlives it — see
// docs/specs/detached-runner.md), so a refused or reset connection is retried
// with backoff until RETRY_WINDOW_MS has passed since the first attempt. Pending
// prompts live only in the server's memory, so the retried POST simply
// registers the prompt again on the new server. The bridge only knows the URL it
// was started with: a server that comes back on another port is never found,
// and the prompt is denied once the window closes.
//
// `opts` exists for tests: { endpoint, windowMs, firstDelayMs, maxDelayMs, sleep }.
async function askServer(args, opts = {}) {
  const endpoint = opts.endpoint !== undefined ? opts.endpoint : process.env.PLOYD_APPROVAL_URL;
  if (!endpoint) return denied('No approval endpoint configured');
  let url;
  try { url = new URL(endpoint); } catch { return denied('Bad approval endpoint'); }

  const windowMs = opts.windowMs !== undefined ? opts.windowMs : RETRY_WINDOW_MS;
  const maxDelay = opts.maxDelayMs !== undefined ? opts.maxDelayMs : RETRY_MAX_MS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let delay = opts.firstDelayMs !== undefined ? opts.firstDelayMs : RETRY_FIRST_MS;
  const started = Date.now();

  const body = JSON.stringify({ tool_name: args.tool_name, input: args.input ?? {} });
  for (;;) {
    const outcome = await postOnce(url, body);
    if (outcome.decision) return outcome.decision;
    if (!outcome.retry || Date.now() - started + delay > windowMs) return denied(outcome.message);
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

// Build the JSON-RPC reply for one incoming message. Returns null for messages
// that take no reply (notifications). `ask(args) -> Promise<decision>` is injected.
async function respond(msg, ask) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ployd', version: '1.0.0' },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [TOOL_DEF] } };
    case 'tools/call': {
      const name = params && params.name;
      if (name !== TOOL_NAME) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(denied(`Unknown tool: ${name}`)) }], isError: true },
        };
      }
      const decision = await ask((params && params.arguments) || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } };
    }
    default:
      // Notifications (no id) and unknown methods: ack nothing / report not-found.
      if (method && method.startsWith('notifications/')) return null;
      if (id === undefined || id === null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    respond(msg, askServer)
      .then((reply) => { if (reply) process.stdout.write(JSON.stringify(reply) + '\n'); })
      .catch(() => {});
  });
  // The agent that spawned us is gone. Don't linger retrying for a run that no
  // longer exists.
  rl.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { respond, askServer, TOOL_NAME, TOOL_DEF, RETRY_WINDOW_MS };

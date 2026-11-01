# Detached runs: task runs that survive a server restart (phase 1)

Status: implemented behind `Settings.detachedRuns` (default off).

## The problem

Today every agent run is a child process of the Ployd server. The child's
stdout and stderr are pipes into the server. When the server goes away, the
runs go with it:

- Quitting the app calls `runner.stopAll()`, which kills every run.
- A crash closes the pipes. The child dies on its next write (SIGPIPE).
- Relaunching to apply an auto-update is a quit, so it kills every run too.

On the next boot, `store.ts` finds the tasks still marked `running` and marks
them `failed` ("Server restarted while task was running"). The work is lost,
and a long run has to start again.

Herdr keeps its agents in a separate background server so they outlive the
app. Phase 1 gets most of that benefit without a second server: the agent
process no longer depends on the Ployd server being alive, and the server can
pick a run back up after it restarts.

## Scope

Phase 1 covers the two run types that live on a task card:

- `runner.dispatch` (fresh runs and resumes: follow-ups, review passes,
  conflict fixes).
- `runner.codeReview` (the Code Review stage).

These stay attached, exactly as today:

- Grooming, orchestration, Ask and memory distillation. They are short, and
  their finish logic needs callbacks (`onSpawn`, the orchestrator engine) that
  are not trivial to rebuild after a restart. See "Phase 2".
- In-app terminal sessions. They already restore as fresh shells.

## The setting

`Settings.detachedRuns`, default `false`. It is a toggle in Settings → General
→ Concurrency. `PATCH /api/settings` accepts only a boolean for it.

With the setting off, nothing changes. Runs use pipes, quit kills them, and a
restart marks them failed, exactly as before.

The setting is read when a run starts. A run keeps the mode it started in.

## Design

### Starting a detached run

When the setting is on (and the platform is not Windows), `launch()` does this
instead of the pipe spawn:

1. It makes a folder for the run under `PLOYD_DATA_DIR/runs/`.
2. It writes the prompt to a file there (mode 0600). That file is the child's
   stdin. The child reads the whole prompt from the file, so the server dying
   later cannot cut the prompt short. A backend that does not read stdin (Grok)
   gets `/dev/null` as stdin and keeps its own `--prompt-file`.
3. The child's stdout and stderr are two files in the same folder, not pipes.
   A file has no reader to lose, so the child never gets SIGPIPE.
4. The child is spawned with `detached: true`. It leads its own process group,
   so a signal to the server's group does not reach it.
5. It writes a small record file (`run.json`) next to the output files.

### The record

`runs/<taskId>-<run>/run.json` holds:

- `taskId`, `kind` (`dispatch` or `codeReview`) and `agent`.
- `pid` and `startTime`: the process start time as `ps -o lstart=` prints it.
- The paths of the output files and the prompt file.
- `offset` and `errOffset`: how many bytes of stdout and stderr the server
  has already handled.
- `tempFiles`: files to delete when the run ends (Grok's temp prompt file).
- `implementationSessionId` (Code Review only), so the task's session id can
  be restored after the review, as today.
- `stopped`: set when the user stops the run.

The record is a sidecar file, not a field on the task. The offset changes
many times per second, and `db.json` is a large, debounced write. The sidecar
is small and is written synchronously after each batch of lines.

### Watching

The server polls the stdout file every 250 ms. It reads from the saved offset,
splits the new bytes into lines, and keeps an incomplete last line for the
next read. Each complete line goes through the same `adapter.parseLine` →
normalized-event code the pipe path uses. So the board, the NDJSON task log,
the usage ledger and SSE all behave the same. Stderr is tailed the same way.

After each batch, the new offsets go into the record. A line before the saved
offset is never parsed again.

While the server that spawned the child is still running, it still gets the
child's `exit` event. On that event it reads whatever is left in the files and
finishes the run.

### Boot: reattach or finish

`store.ts` no longer marks a `running` or `code_review` task failed when the
task has a run record. `runner.reattachAll()` runs in `index.start()` before
the server listens. For each record:

1. It reads lines `0 .. offset` again, but only to rebuild state: the open
   subagents and the result event if one was already seen. Nothing is
   recorded, broadcast or billed a second time.
2. If the pid is alive **and** its start time matches the record, the run is
   still going. The server adds it back to its live set and resumes tailing
   from the saved offset. A once-a-second check notices when the process ends.
3. If the process is gone, the server reads the rest of the file. If the file
   holds the adapter's final result event, the run finishes exactly as if it
   ended normally: the success branch, memory distillation, the Code Review
   hand-off, and so on. If not, the task is marked `failed` with a clear `proc`
   log line.

The start-time check guards against pid reuse. If the record has no start
time (`ps` failed when the run started), the server treats the process as gone.
That is the safe choice: it may fail a run that is still alive, but it never
tails or kills an unrelated process.

### The exit code

After a restart the server is no longer the parent, so it cannot read the
exit code. So for a detached run, the outcome comes from the stream only:

- A result event that is not an error → success.
- A result event that is an error, or no result event → failed.
- `stopped` in the record (the user pressed Stop) → stopped.

The attached path of a detached run uses the same rule, so both paths agree.
One small difference from a pipe run: a pipe run treats any signal as "stopped
by user". A detached run that dies from a signal nobody sent through Ployd (for
example the OOM killer) is marked failed, which is more honest. The log line
says "exit unknown" when there is no exit code.

### Stop

`runner.stop` sends SIGTERM to the whole process group (`kill(-pid)`), then
SIGKILL after 5 seconds if the run is still live. This kills the agent and
everything it started (the permission bridge, tool processes). It works before
and after a restart, because it needs only the pid. Stop also sets `stopped`
in the record, so a stop that lands just before a restart is still a stop.

### Quit

`runner.shutdown()` replaces `stopAll()` on Electron's `before-quit` and the
dev server's SIGINT. With the setting on, it stops the attached runs, saves the
detached runs' offsets, and leaves those processes alone. With the setting off,
it is `stopAll()`, as today.

### Permission bridge

`server/permission-mcp.js` (still plain JS) POSTs a prompt to the server and
waits. If the server is restarting, that POST fails with "connection refused"
or "connection reset". The bridge now retries those errors with backoff (1 s,
doubling, at most 10 s) until 30 minutes have passed since the first attempt.
That is the same as the server's own deny timeout. After that it denies.

Pending prompts live only in server memory. So a retried POST simply creates
the prompt again, and the board shows it again. Reattach runs before the server
listens, so the re-POST finds the task live.

The bridge now also exits when its stdin closes (the agent went away), so it
cannot linger while retrying.

**Limitation:** the bridge knows only the URL it was started with. If the
server comes back on a different port of the ladder (7777…7782, because 7777
was busy), the bridge cannot find it. It keeps retrying and then denies after
30 minutes. The run itself still reattaches; only that one prompt is lost.

### Windows

Windows has no process groups in the POSIX sense. `detached: true` there makes
a new console, not a group, and `kill(-pid)` does not exist. Node also cannot
send a signal to a process that is not its own child. So on Windows a run is
always attached, even with the setting on. The settings hint says so.

## Failure modes

| What happens | Result |
|---|---|
| Server crashes or quits mid-run | The run continues. On boot it is reattached. |
| Run finishes while the server is down | On boot the result is read from the file and the run finishes normally. |
| Run dies while the server is down, with no result | On boot the task is marked failed: "The run ended while Ployd was not running, without a result". |
| Pid reused by another process | Start time does not match. Treated as gone, finished from the file. |
| Record file is corrupt or unreadable | Ignored and deleted. The task falls back to today's rule (failed). |
| The server dies between handling a line and saving the offset | That batch can be handled again on boot. The window is one synchronous batch. |
| The server dies after finishing a run but before `db.json` is written | The record is deleted only after `db.json` is flushed, so the boot sees the record again and finishes the run again from the file. |
| Disk full while writing output | The child's own writes fail. Same as any full disk today. |
| Permission prompt during a restart | Re-registered when the server returns on the same port. |
| User turns the setting off while detached runs are live | Those runs keep running and are tracked as detached. The next quit stops them, as today. |

## The "orphaned running tasks" rule

Before: any task still `running` on boot is marked `failed`, and any task still
in `code_review` is parked in `validation`.

After: the same, **unless the task has a run record**. A task with a record is
left as it is, and `runner.reattachAll()` decides the outcome from the process
and the output file.

Why: the rule existed because a run could not outlive the server. A detached
run can. Failing it on boot would throw away work that is still going, or
already done.

## Disk use

The output files duplicate the NDJSON task log while a run is live. They are
deleted when the run finishes, together with the prompt file and the record.

## Phase 2

To make the rest survive a restart:

- **Grooming, orchestration, Ask, memory.** Their finish logic needs
  callbacks (`onSpawn` creating tasks, the orchestrator engine's resume). Each
  needs a finish function that can be rebuilt from a record alone, like
  `dispatch` and `codeReview` have now. Ask also needs somewhere to send its
  answer when no board is waiting for it.
- **Terminal sessions.** The pty relay is a child of the server. Surviving a
  restart needs a small session daemon that owns the ptys and that the server
  connects to, with a scrollback buffer it can replay. That is a separate
  process with its own lifecycle, which is the larger step Herdr takes.
- **Windows.** Use a job object or a helper process that owns the run, since
  there are no process groups to signal.
- **Port changes.** Let the permission bridge find the server again, for
  example by reading the current port from a file in `PLOYD_DATA_DIR`.

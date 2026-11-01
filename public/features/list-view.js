/* Ployd — list view. No build step: native ES module.
 *
 * The board's second shape: the same cards as the Kanban, drawn as one dense
 * table grouped by column. A Kanban is good at "what moves next"; a list is
 * good at "show me everything, sorted" — scanning many tasks, comparing cost
 * and grade, and reading long titles that a 300px card wraps into three lines.
 *
 * It is a view, not a second board, and it follows three rules:
 *
 *  - Same data, same filters. renderBoard() hands it the very cards the Kanban
 *    would draw (already scoped to the workspace and the filter box), so the
 *    two can never disagree about what exists.
 *  - Same actions. A row opens the same drawer and the same context menu a
 *    card does. Nothing here moves a task between columns by itself: there is
 *    no drag-and-drop, so status changes go through the "…" button (the card's
 *    right-click menu), exactly as they do from the drawer.
 *  - Preferences are per device. Which view is in front, the sort and the
 *    collapsed groups live in localStorage like the theme and layout do, never
 *    in db.json.
 *
 * The table is redrawn on every SSE tick, so focus and scroll position are
 * carried across a redraw by hand (see renderListView).
 */
import { agentBadge, elapsedSince, esc, fmtTokens, relativeTime, tokensOnly, totalTokens } from '../core/api.js';
import { $, COLUMNS, COLUMN_OF_STATUS, GROOMING_COLUMN, ORCH_COLUMN, icon, isAutoApprove, isGroomingLive, isLive, isOrchestrationLive, pendingPermissions, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { GRADE_MEANINGS, stopGrooming, stopOrchestration } from './cards.js';
import { openContextMenu, openGroomingContextMenu, showContextMenu } from './context-menu.js';
import { stopTask } from './dnd.js';
import { openDrawer, openGroomingDrawer, openOrchestrationDrawer } from './drawer.js';
import { filtersActive } from './filters.js';
import { orchestrationCoreActions } from './permissions.js';
import { prChipHtml, refreshPr } from './pr.js';
import { openTaskTerminal } from './terminal.js';


// ---------- preferences ----------
const VIEW_KEY = 'ployd.boardView';      // 'board' | 'list'
const SORT_KEY = 'ployd.listSort';       // { key, dir }
const COLLAPSED_KEY = 'ployd.listCollapsed'; // { [groupKey]: boolean }

// Done only grows, so it starts folded. Every other group starts open. A
// user's own choice for a group (either way) is stored and wins from then on.
const DEFAULT_COLLAPSED = { done: true };

const SORTS = {
  title: { label: 'Title', dir: 'asc' },
  updated: { label: 'Updated', dir: 'desc' },
  cost: { label: 'Cost', dir: 'desc' },
  grade: { label: 'Grade', dir: 'desc' },
};

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === 'object' ? v : fallback;
  } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable — non-fatal */ }
}

function boardViewMode() {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

// The key is written for both values, the default included, for the same
// reason the layout key is: clearing it would hand the choice back to
// whatever a later release defaults to.
function setBoardViewMode(mode) {
  const next = mode === 'list' ? 'list' : 'board';
  try { localStorage.setItem(VIEW_KEY, next); } catch { /* non-fatal */ }
  syncViewToggle();
  renderBoard();
}

function toggleBoardViewMode() {
  setBoardViewMode(boardViewMode() === 'list' ? 'board' : 'list');
}

function currentSort() {
  const s = readJson(SORT_KEY, {});
  const key = Object.prototype.hasOwnProperty.call(SORTS, s.key) ? s.key : 'updated';
  const dir = s.dir === 'asc' || s.dir === 'desc' ? s.dir : SORTS[key].dir;
  return { key, dir };
}

// Clicking the active header flips its direction; clicking another one starts
// it in the direction that reads naturally for it (A→Z, newest, priciest, best).
function sortBy(key) {
  if (!Object.prototype.hasOwnProperty.call(SORTS, key)) return;
  const cur = currentSort();
  const dir = cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : SORTS[key].dir;
  writeJson(SORT_KEY, { key, dir });
  renderBoard();
}

function isCollapsed(group) {
  const c = readJson(COLLAPSED_KEY, {});
  if (typeof c[group] === 'boolean') return c[group];
  return !!DEFAULT_COLLAPSED[group];
}
function toggleGroup(group) {
  const c = readJson(COLLAPSED_KEY, {});
  c[group] = !isCollapsed(group);
  writeJson(COLLAPSED_KEY, c);
  renderBoard();
}

// The filter bar's two-button switch. Lives in static markup (index.html), so
// it only needs its pressed state kept current.
function syncViewToggle() {
  const mode = boardViewMode();
  document.querySelectorAll('#view-toggle [data-view]').forEach((b) => {
    const on = b.dataset.view === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}


// ---------- rows ----------
// Sort values per entity. A missing value sorts last whichever way you sort,
// so "Grade" doesn't open on a wall of ungraded tasks.
function sortValue(item, key) {
  const x = item.data;
  if (key === 'title') return (x.title || '').toLowerCase();
  if (key === 'updated') return x.updatedAt || x.createdAt || '';
  if (key === 'cost') return x.costUsd > 0 ? x.costUsd : (item.kind === 'task' && totalTokens(x) > 0 ? totalTokens(x) / 1e9 : null);
  if (key === 'grade') return item.kind === 'task' && x.codeReview ? Number(x.codeReview.grade) || null : null;
  return null;
}

function sortItems(items, { key, dir }) {
  const sign = dir === 'asc' ? 1 : -1;
  return items.slice().sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    const ea = va === null || va === '';
    const eb = vb === null || vb === '';
    if (ea !== eb) return ea ? 1 : -1;
    if (!ea && va !== vb) return (va < vb ? -1 : 1) * sign;
    // Ties fall back to most recently touched, so the order is stable.
    return (b.data.updatedAt || '').localeCompare(a.data.updatedAt || '');
  });
}

const DASH = '<span class="tl-none">—</span>';

function costHtml(x, kind) {
  if (x.costUsd > 0) return `<span class="tl-num">$${x.costUsd.toFixed(2)}</span>`;
  // Codex and most Grok subscription runs report tokens, not dollars: show the
  // tokens rather than a misleading $0.00 (same rule as the drawer).
  if (kind === 'task' && tokensOnly(x) && totalTokens(x) > 0) {
    return `<span class="tl-num" title="Tokens used — this backend reports no dollar cost">${fmtTokens(totalTokens(x))} tok</span>`;
  }
  return DASH;
}

function gradeHtml(cr) {
  if (!cr) return DASH;
  const g = Math.min(5, Math.max(1, Math.round(Number(cr.grade) || 0)));
  return `<span class="chip grade g${g}" title="Code review grade ${g}/5 — ${esc(GRADE_MEANINGS[g])}">${g}/5</span>`;
}

function modelLabel(x) {
  return x.model === 'default' ? (x.resolvedModel || 'default') : (x.model || 'default');
}

function liveHtml(startedAt, label, stopTitle) {
  return `<span class="tl-live"><span class="spinner"></span>${label ? `<span class="live-label">${esc(label)}</span>` : ''}` +
    `<span class="elapsed" data-start="${esc(startedAt)}"></span></span>` +
    `<button class="btn icon danger tl-act" data-act="stop" title="${esc(stopTitle)}" aria-label="${esc(stopTitle)}">${icon('square')}</button>`;
}

const moreBtn = (title) =>
  `<button class="btn icon tl-act" data-act="menu" title="Actions" aria-label="${esc(`Actions for ${title}`)}" aria-haspopup="menu">${icon('ellipsis')}</button>`;

function taskRow(t) {
  const flags = [];
  if (t.status === 'failed') flags.push('<span class="chip badge-failed">FAILED</span>');
  if (t.lastOutcome === 'stopped') flags.push('<span class="chip badge-stopped">stopped</span>');
  if (t.resolvingConflicts) flags.push(`<span class="chip conflict-chip">${icon('git-branch')} conflicts</span>`);
  const pending = pendingPermissions(t.id).length;
  if (pending) flags.push(`<span class="chip needs-approval" title="Waiting for you to approve a tool">${icon('shield')} ${pending} to approve</span>`);
  if (isLive(t) && isAutoApprove(t.id)) flags.push(`<span class="chip auto-approve" title="Auto-approving every tool">${icon('zap')} auto</span>`);
  if (t.status === 'running' && t.activeSubagents > 0) flags.push(`<span class="chip subagents">${icon('bot')} ${t.activeSubagents}</span>`);

  const badge = agentBadge(t);
  const agent = `${badge ? `<span class="tl-agent" title="${esc(badge.title)}">${icon(badge.icon)} ${esc(badge.label)}</span>` : ''}` +
    `<span class="chip model">${esc(modelLabel(t))}</span>`;

  // A branch shows its live PR once we know there is one; until then (or with
  // no PR) the branch name itself is the useful bit.
  let branch = DASH;
  if (t.branch) {
    const res = state.prByTask.get(t.id);
    if (res === undefined) refreshPr(t.id);
    branch = (res && res.pr) ? prChipHtml(t) : `<span class="tl-branch" title="${esc(t.worktreePath || '')}">${icon('git-branch')} ${esc(t.branch)}</span>`;
  } else if (t.useWorktree) {
    branch = `<span class="tl-branch tl-dim" title="A worktree branch is created on dispatch">${icon('git-branch')} ${esc(t.branchName || 'on dispatch')}</span>`;
  }

  const live = isLive(t)
    ? liveHtml(t.startedAt, t.status === 'code_review' ? 'review' : (t.resolvingConflicts ? 'conflicts' : ''), 'Stop run')
    : '';
  const termTitle = `Terminal on this task's ${t.worktreePath ? 'worktree' : 'repo'}`;

  return `
    <tr class="tl-row${isLive(t) ? ' live' : ''}${t.status === 'failed' ? ' failed' : ''}" tabindex="0"
        data-kind="task" data-id="${esc(t.id)}" aria-label="${esc(t.title)}">
      <td class="tl-title-cell">
        <span class="tl-title">${esc(t.title)}</span>
        ${flags.length ? `<span class="tl-flags">${flags.join('')}</span>` : ''}
        ${t.status === 'failed' && t.lastError ? `<span class="tl-error" title="${esc(t.lastError)}">${esc(t.lastError.slice(0, 140))}</span>` : ''}
      </td>
      <td class="tl-col-agent">${agent}</td>
      <td class="tl-col-branch">${branch}</td>
      <td class="tl-col-grade">${gradeHtml(t.codeReview)}</td>
      <td class="tl-col-cost">${costHtml(t, 'task')}</td>
      <td class="tl-col-updated"><span class="tl-time" title="${esc(t.updatedAt || '')}">${esc(relativeTime(t.updatedAt || t.createdAt))}</span></td>
      <td class="tl-col-actions">
        ${live}
        <button class="btn icon tl-act" data-act="terminal" title="${esc(termTitle)}" aria-label="${esc(`Open a terminal session on ${t.title}`)}">${icon('terminal')}</button>
        ${moreBtn(t.title)}
      </td>
    </tr>`;
}

const GROOMING_STATUS = { draft: 'Draft', running: 'Grooming', awaiting: 'Needs input', finished: 'Groomed', failed: 'Failed' };
const ORCH_STATUS = { draft: 'Draft', running: 'Orchestrating', waiting: 'Watching workers', awaiting: 'Needs input', finished: 'Done', failed: 'Failed' };

// Groomings and orchestrations share the table's columns where they mean the
// same thing (model, cost, updated) and leave the task-only ones empty.
function sideRow(kind, x) {
  const labels = kind === 'grooming' ? GROOMING_STATUS : ORCH_STATUS;
  const live = kind === 'grooming' ? isGroomingLive(x) : isOrchestrationLive(x);
  const stateCls = `${kind === 'grooming' ? 'groom' : 'orch'}-status-${x.status}`;
  const flags = [`<span class="chip ${esc(stateCls)}">${esc(labels[x.status] || x.status)}</span>`];
  if (x.status === 'awaiting') flags[0] = `<span class="chip badge-awaiting">${icon('circle-help')} ${esc(labels.awaiting)}</span>`;
  if (x.status === 'failed') flags[0] = '<span class="chip badge-failed">FAILED</span>';
  const spawned = (x.taskIds || []).length;
  if (spawned) flags.push(`<span class="chip" title="Tasks it created">${spawned} task${spawned === 1 ? '' : 's'}</span>`);
  const stopTitle = kind === 'grooming' ? 'Stop grooming' : 'Stop orchestration';
  return `
    <tr class="tl-row${live ? ' live' : ''}" tabindex="0" data-kind="${kind}" data-id="${esc(x.id)}" aria-label="${esc(x.title)}">
      <td class="tl-title-cell">
        <span class="tl-title">${esc(x.title)}</span>
        <span class="tl-flags">${flags.join('')}</span>
      </td>
      <td class="tl-col-agent"><span class="chip model">${esc(modelLabel(x))}</span></td>
      <td class="tl-col-branch">${DASH}</td>
      <td class="tl-col-grade">${DASH}</td>
      <td class="tl-col-cost">${costHtml(x, kind)}</td>
      <td class="tl-col-updated"><span class="tl-time" title="${esc(x.updatedAt || '')}">${esc(relativeTime(x.updatedAt || x.createdAt))}</span></td>
      <td class="tl-col-actions">
        ${live ? liveHtml(x.startedAt, '', stopTitle) : ''}
        ${moreBtn(x.title)}
      </td>
    </tr>`;
}

function headerCell(key, cls) {
  const s = currentSort();
  const on = s.key === key;
  const aria = on ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const arrow = on ? icon(s.dir === 'asc' ? 'arrow-up' : 'arrow-down') : '';
  return `<th class="${cls}" scope="col" aria-sort="${aria}">
      <button type="button" class="tl-sort${on ? ' active' : ''}" data-sort="${key}">${esc(SORTS[key].label)}${arrow}</button>
    </th>`;
}

// One empty cell per data column rather than a colspan: the narrow-window
// rules hide columns cell by cell, and a fixed colspan would keep their slots.
const GROUP_FILLER = ['agent', 'branch', 'grade', 'cost', 'updated', 'actions']
  .map((c) => `<td class="tl-col-${c}"></td>`).join('');

function groupHtml(group, rows) {
  const collapsed = isCollapsed(group.key);
  return `
    <tbody class="tl-group${collapsed ? ' collapsed' : ''}" data-group="${esc(group.key)}">
      <tr class="tl-group-head">
        <th class="tl-title-cell" scope="rowgroup">
          <button type="button" class="tl-group-toggle" data-group-toggle="${esc(group.key)}" aria-expanded="${!collapsed}">
            ${icon(collapsed ? 'chevron-right' : 'chevron-down')}
            <span class="dot" style="background:${group.dot}"></span>
            <span class="tl-group-label">${esc(group.label)}</span>
            <span class="count">${group.count}</span>
          </button>
        </th>
        ${GROUP_FILLER}
      </tr>
      ${collapsed ? '' : rows}
    </tbody>`;
}


// ---------- render ----------
// Draws the list into `board` (the same #board the Kanban uses). The caller
// passes the cards already scoped and filtered; `showGrooming` /
// `showOrchestration` mirror the board's rule for when those lanes appear.
function renderListView(board, { tasks, groomings, orchestrations, showGrooming, showOrchestration }) {
  // Keep the reader's place: the table is rebuilt from scratch on every tick.
  const scrollTop = board.scrollTop;
  const focused = document.activeElement && board.contains(document.activeElement)
    ? document.activeElement : null;
  const focusRow = focused && focused.closest('.tl-row');
  const focusKey = focusRow ? `${focusRow.dataset.kind}:${focusRow.dataset.id}` : null;
  const focusSort = focused && focused.dataset.sort;
  const focusGroup = focused && focused.dataset.groupToggle;

  const sort = currentSort();
  const groups = [];
  if (showGrooming && groomings.length) {
    groups.push({ ...GROOMING_COLUMN, count: groomings.length,
      rows: sortItems(groomings.map((g) => ({ kind: 'grooming', data: g })), sort) });
  }
  if (showOrchestration && orchestrations.length) {
    groups.push({ ...ORCH_COLUMN, count: orchestrations.length,
      rows: sortItems(orchestrations.map((o) => ({ kind: 'orchestration', data: o })), sort) });
  }
  for (const col of COLUMNS) {
    const inCol = tasks.filter((t) => COLUMN_OF_STATUS[t.status] === col.key);
    if (!inCol.length) continue;
    groups.push({ ...col, count: inCol.length, rows: sortItems(inCol.map((t) => ({ kind: 'task', data: t })), sort) });
  }

  if (!groups.length) {
    board.innerHTML = `<div class="tl-empty">${filtersActive()
      ? 'No tasks match the filter.'
      : `No tasks yet. Use ${icon('plus')} New Task to queue one.`}</div>`;
    return;
  }

  const body = groups.map((g) => groupHtml(g, g.rows.map((r) =>
    (r.kind === 'task' ? taskRow(r.data) : sideRow(r.kind, r.data))).join(''))).join('');

  board.innerHTML = `
    <table class="task-list">
      <thead>
        <tr>
          ${headerCell('title', 'tl-title-cell')}
          <th class="tl-col-agent" scope="col">Agent</th>
          <th class="tl-col-branch" scope="col">Branch / PR</th>
          ${headerCell('grade', 'tl-col-grade')}
          ${headerCell('cost', 'tl-col-cost')}
          ${headerCell('updated', 'tl-col-updated')}
          <th class="tl-col-actions" scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      ${body}
    </table>`;

  // Fill the live timers now rather than waiting up to a second for the ticker.
  board.querySelectorAll('.elapsed[data-start]').forEach((el) => {
    el.textContent = elapsedSince(el.dataset.start);
  });

  board.scrollTop = scrollTop;
  let target = null;
  if (focusKey) {
    const [kind, id] = focusKey.split(':');
    target = [...board.querySelectorAll('.tl-row')].find((r) => r.dataset.kind === kind && r.dataset.id === id);
  } else if (focusSort) {
    target = board.querySelector(`[data-sort="${focusSort}"]`);
  } else if (focusGroup) {
    target = [...board.querySelectorAll('[data-group-toggle]')].find((b) => b.dataset.groupToggle === focusGroup);
  }
  if (target) target.focus({ preventScroll: true });
}

// ---------- interaction ----------
function entityFor(row) {
  const { kind, id } = row.dataset;
  if (kind === 'task') return state.tasks.get(id);
  if (kind === 'grooming') return state.groomings.get(id);
  if (kind === 'orchestration') return state.orchestrations.get(id);
  return null;
}

function openRow(row) {
  const { kind, id } = row.dataset;
  if (kind === 'task') openDrawer(id);
  else if (kind === 'grooming') openGroomingDrawer(id);
  else if (kind === 'orchestration') openOrchestrationDrawer(id);
}

function rowMenu(row, x, y) {
  const item = entityFor(row);
  if (!item) return;
  const { kind } = row.dataset;
  if (kind === 'task') openContextMenu(item, x, y);
  else if (kind === 'grooming') openGroomingContextMenu(item, x, y);
  else showContextMenu(orchestrationCoreActions(item), x, y);
}

function stopRow(row) {
  const { kind, id } = row.dataset;
  if (kind === 'task') stopTask(id);
  else if (kind === 'grooming') stopGrooming(id);
  else stopOrchestration(id);
}

function menuAtElement(row, el) {
  const r = el.getBoundingClientRect();
  rowMenu(row, r.left, r.bottom + 4);
}

function inList(e) {
  const board = $('#board');
  return board && board.classList.contains('board-list') && board.contains(e.target);
}

// Load-time wiring. Called from app.js; see the init() contract in CLAUDE.md.
export function init() {
  syncViewToggle();
  $('#view-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setBoardViewMode(b.dataset.view);
  });

  // One delegated listener set on #board: the table is rebuilt on every tick,
  // so per-row listeners would only be thrown away.
  const board = $('#board');
  board.addEventListener('click', (e) => {
    if (!inList(e)) return;
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { sortBy(sortBtn.dataset.sort); return; }
    const groupBtn = e.target.closest('[data-group-toggle]');
    if (groupBtn) { toggleGroup(groupBtn.dataset.groupToggle); return; }
    const row = e.target.closest('.tl-row');
    if (!row) return;
    // The PR chip is a real link; let it open without also opening the drawer.
    if (e.target.closest('a[href]')) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      e.preventDefault();
      // The document-level click handler closes any open context menu; the
      // "…" button opens one, so this click must not reach it.
      if (act.dataset.act === 'menu') e.stopPropagation();
      const a = act.dataset.act;
      if (a === 'stop') stopRow(row);
      else if (a === 'menu') menuAtElement(row, act);
      else if (a === 'refresh-pr') refreshPr(row.dataset.id, true);
      else if (a === 'terminal') { const t = entityFor(row); if (t) openTaskTerminal(t); }
      return;
    }
    openRow(row);
  });
  board.addEventListener('contextmenu', (e) => {
    if (!inList(e)) return;
    const row = e.target.closest('.tl-row');
    if (!row) return;
    e.preventDefault();
    rowMenu(row, e.clientX, e.clientY);
  });
  // Rows are a roving list: ↑/↓ (and j/k) walk them, Home/End jump, Enter
  // opens, and the context-menu key or Shift+F10 opens the actions menu.
  board.addEventListener('keydown', (e) => {
    if (!inList(e)) return;
    const row = e.target.closest('.tl-row');
    if (!row || e.target !== row) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = [...board.querySelectorAll('.tl-row')];
    const i = rows.indexOf(row);
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'j') next = rows[i + 1];
    else if (e.key === 'ArrowUp' || e.key === 'k') next = rows[i - 1];
    else if (e.key === 'Home') next = rows[0];
    else if (e.key === 'End') next = rows[rows.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(row); return; }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); menuAtElement(row, row); return; }
    else return;
    e.preventDefault();
    if (next) next.focus();
  });
}

export { boardViewMode, renderListView, setBoardViewMode, syncViewToggle, toggleBoardViewMode };

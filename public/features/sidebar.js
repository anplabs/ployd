/* Ployd — sidebar. No build step: native ES module. */
import { agentBadge, esc, relativeTime } from '../core/api.js';
import { $, icon, isGroomingLive, isOrchestrationLive, pendingPermissions, state } from '../core/state.js';
import { openContextMenu } from './context-menu.js';
import { openDrawer, openGroomingDrawer, openOrchestrationDrawer } from './drawer.js';
import { openReposModal } from './repos-modal.js';
import { activeTabKey } from './tabs.js';
import { STATUS_LABEL, focusSession, openNewSessionMenu, sessionsForRepo } from './terminal.js';
import { currentLayout } from './theme.js';
import { enterWorkspace, exitWorkspace, githubAvatarUrl, refreshRepoBranchCard } from './workspaces.js';


// ---------- project sidebar ("sidebar" layout) ----------
// The rail answers one question first: which agent needs me? It used to list
// every card of every project grouped by board column, which made it a second,
// cramped board you had to read top to bottom. Now it has two sections, after
// herdr's "a space per repo, and the sidebar shows which one needs you":
//
//   Agents   — only the work that is in motion or waiting on you, across every
//              project, sorted by urgency: Needs you > Working > Done (finished
//              and not looked at yet). Everything else lives on the board.
//   Projects — one row per repo (its branch and a rolled-up status), with the
//              repo's terminal sessions nested under it like tabs.
//
// It is pure navigation — clicking a row opens the drawer, the board or the
// shell — so nothing here can change a task's state. The only thing it creates
// is a terminal session. Renders only while the layout is on.

// How many rows an Agents group or a project's session list shows before it
// truncates. The overflow row expands in place, since an Agents group spans
// projects and has no single board to send you to.
const SIDEBAR_MAX_ROWS = 5;
// Groups the user unfolded past the cap, by key ('needs' | 'working' | 'done' |
// `sessions:<repoId>`). In memory like the rest of the board's transient UI.
const expandedGroups = new Set();
// Organization groups the user folded away, by org key. Inverted on purpose
// (collapsed rather than expanded): a group is open until you close it, so
// grouping never hides a project you could see before.
const sidebarOrgCollapsed = new Set();

const sidebarOn = () => currentLayout() === 'sidebar';

// ---- "seen": herdr's done vs idle ----
// A finished run stays in Done until you open it; after that it's idle and
// leaves the rail (it's still on the board). Stored per device next to the
// theme and the tabs, keyed by card id, as the `finishedAt` you saw — a new run
// stamps a new one, so the card comes back when it finishes again.
const SEEN_KEY = 'ployd.sidebarSeen';
let seen = null; // id -> finishedAt (or updatedAt when a card has none)

const finishStamp = (item) => item.finishedAt || item.updatedAt || '';

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch { /* malformed or unavailable storage: start over */ }
  return null;
}
function saveSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* non-fatal */ }
}
// Every finished card that exists right now, keyed for the seen map.
function finishedItems() {
  return [
    ...[...state.tasks.values()].filter((t) => t.status === 'validation' || t.status === 'failed'),
    ...[...state.groomings.values()].filter((g) => g.status === 'finished' || g.status === 'failed'),
    ...[...state.orchestrations.values()].filter((o) => o.status === 'finished' || o.status === 'failed'),
  ];
}
// The first time the rail runs on a device there is no history, and every card
// already in Validation would show up as "Done". Treat what exists at that
// moment as seen, so Done starts empty and fills only with new results.
function ensureSeen() {
  if (seen) return true;
  seen = loadSeen();
  if (seen) return true;
  // Wait for the first render that has data — boot() applies the layout before
  // any state is loaded, and seeding from that empty pass would seed nothing.
  if (!state.repos.length) { seen = null; return false; }
  seen = {};
  for (const item of finishedItems()) seen[item.id] = finishStamp(item);
  saveSeen();
  return true;
}
const isUnseen = (item) => !!seen && seen[item.id] !== finishStamp(item);

// Called by the drawer when it stops showing a card (closed, or switched to
// another one): whatever result you were looking at counts as seen. Marked on
// leave rather than on open, so the row you clicked doesn't vanish under the
// cursor while its drawer is still open.
function markSeen(id) {
  if (!id || !ensureSeen()) return;
  const item = state.tasks.get(id) || state.groomings.get(id) || state.orchestrations.get(id);
  if (!item) return;
  seen[item.id] = finishStamp(item);
  // Drop ids for cards that no longer exist, so the map can't grow forever.
  for (const key of Object.keys(seen)) {
    if (!state.tasks.has(key) && !state.groomings.has(key) && !state.orchestrations.has(key)) delete seen[key];
  }
  saveSeen();
  renderSidebar();
}
// "Clear" on the Done heading: everything finished so far is seen.
function markAllSeen() {
  if (!ensureSeen()) return;
  for (const item of finishedItems()) seen[item.id] = finishStamp(item);
  saveSeen();
  renderSidebar();
}

// ---- agent state ----
// One shape for tasks, groomings and orchestrations, so the rail can sort and
// render them together. `state` is herdr's vocabulary: 'needs' (blocked on you),
// 'working', 'done' (finished, unseen) — or null when the card is just sitting
// on the board and has no business in the rail.
const repoName = (repoId) => state.repos.find((r) => r.id === repoId)?.name || '';

function taskAgent(t) {
  const asks = pendingPermissions(t.id).length;
  let st = null, label = '';
  if (asks) { st = 'needs'; label = `${asks} approval${asks === 1 ? '' : 's'}`; }
  else if (t.status === 'running') { st = 'working'; label = 'running'; }
  else if (t.status === 'code_review') { st = 'working'; label = 'code review'; }
  else if (t.status === 'failed' && isUnseen(t)) { st = 'done'; label = 'failed'; }
  else if (t.status === 'validation' && isUnseen(t)) { st = 'done'; label = 'to validate'; }
  if (!st) return null;
  const badge = agentBadge(t);
  return {
    kind: 'task', id: t.id, title: t.title, repoId: t.repoId, state: st, label,
    failed: t.status === 'failed', agent: badge ? badge.label : '', at: t.finishedAt || t.updatedAt,
  };
}

function groomingAgent(g) {
  let st = null, label = '';
  if (g.status === 'awaiting') { st = 'needs'; label = 'has questions'; }
  else if (isGroomingLive(g)) { st = 'working'; label = 'grooming'; }
  else if ((g.status === 'finished' || g.status === 'failed') && isUnseen(g)) {
    st = 'done'; label = g.status === 'failed' ? 'grooming failed' : 'groomed';
  }
  if (!st) return null;
  return { kind: 'grooming', id: g.id, title: g.title, repoId: g.repoId, state: st, label, failed: g.status === 'failed', at: g.finishedAt || g.updatedAt };
}

function orchestrationAgent(o) {
  let st = null, label = '';
  if (o.status === 'awaiting') { st = 'needs'; label = 'has a question'; }
  else if (isOrchestrationLive(o)) { st = 'working'; label = 'planning'; }
  else if (o.status === 'waiting') { st = 'working'; label = 'waiting on workers'; }
  else if ((o.status === 'finished' || o.status === 'failed') && isUnseen(o)) {
    st = 'done'; label = o.status === 'failed' ? 'goal failed' : 'goal reached';
  }
  if (!st) return null;
  return { kind: 'orchestration', id: o.id, title: o.title, repoId: o.repoId, state: st, label, failed: o.status === 'failed', at: o.finishedAt || o.updatedAt };
}

function allAgents() {
  return [
    ...[...state.tasks.values()].map(taskAgent),
    ...[...state.groomings.values()].map(groomingAgent),
    ...[...state.orchestrations.values()].map(orchestrationAgent),
  ].filter(Boolean);
}

const STATE_RANK = { needs: 0, working: 1, done: 2 };
// A project's status is its most urgent agent, the way a herdr space rolls up.
function rollup(agents) {
  let best = null;
  for (const a of agents) if (!best || STATE_RANK[a.state] < STATE_RANK[best]) best = a.state;
  return best;
}

// The status glyph every row leads with. Spinner while working, a filled amber
// ring when it's waiting on you, a dot when done (red if it failed), and a
// hollow ring for "nothing going on".
function glyph(st, failed) {
  if (st === 'working') return '<span class="sb-glyph working"><span class="spinner"></span></span>';
  if (st === 'needs') return '<span class="sb-glyph needs" aria-hidden="true"></span>';
  if (st === 'done') return `<span class="sb-glyph done${failed ? ' failed' : ''}" aria-hidden="true"></span>`;
  return '<span class="sb-glyph idle" aria-hidden="true"></span>';
}
const STATE_TEXT = { needs: 'Needs you', working: 'Working', done: 'Done' };

// ---- Agents section ----
function openItemId() {
  return state.openTaskId || state.openGroomingId || state.openOrchestrationId;
}

// Two lines, like herdr's "herdr · working · claude": the card's title, then
// where it lives and what it's doing. The project name is what lets one list
// span every repo without losing track of which is which.
function agentRowHtml(a) {
  const meta = [repoName(a.repoId), a.label, a.agent].filter(Boolean).join(' · ');
  const when = a.state === 'done' && a.at ? relativeTime(a.at) : '';
  const active = openItemId() === a.id;
  return `
      <button class="sb-agent${active ? ' active' : ''}" data-${a.kind}="${esc(a.id)}"
              title="${esc(`${a.title}\n${meta}`)}">
        ${glyph(a.state, a.failed)}
        <span class="sb-agent-text">
          <span class="sb-agent-title">${esc(a.title)}</span>
          <span class="sb-agent-meta${a.state === 'needs' ? ' needs' : ''}${a.failed ? ' failed' : ''}">${esc(meta)}</span>
        </span>
        ${when ? `<span class="sb-agent-when">${esc(when)}</span>` : ''}
      </button>`;
}

function moreRowHtml(key, total) {
  const all = expandedGroups.has(key);
  return `
      <button class="sidebar-more" data-more="${esc(key)}">
        ${icon(all ? 'chevron-up' : 'chevron-down')}
        <span>${all ? 'Show less' : `Show ${total - SIDEBAR_MAX_ROWS} more`}</span>
      </button>`;
}

function agentsSectionHtml(agents) {
  const groups = ['needs', 'working', 'done'].map((st) => ({
    st,
    rows: agents.filter((a) => a.state === st)
      // Most recent first within a group: the newest result, the run that just
      // started, the question that just came in.
      .sort((a, b) => (b.at || '').localeCompare(a.at || '')),
  })).filter((g) => g.rows.length);

  const body = groups.length
    ? groups.map(({ st, rows }) => {
      const shown = expandedGroups.has(st) ? rows : rows.slice(0, SIDEBAR_MAX_ROWS);
      return `
      <div class="sb-group sb-group-${st}">
        <div class="sb-group-head">
          <span class="sb-group-label">${STATE_TEXT[st]}</span>
          <span class="count">${rows.length}</span>
          ${st === 'done'
          ? '<button class="sb-group-action" data-seen-all="1" title="Mark every finished run as seen">Clear</button>'
          : ''}
        </div>
        ${shown.map(agentRowHtml).join('')}
        ${rows.length > SIDEBAR_MAX_ROWS ? moreRowHtml(st, rows.length) : ''}
      </div>`;
    }).join('')
    : '<div class="sidebar-empty">No agents running. Queue a task from Home or a project board.</div>';

  return `
      <section class="sb-section" aria-label="Agents">
        <div class="sb-section-head"><span class="sb-section-title">Agents</span></div>
        ${body}
      </section>`;
}

// ---- Projects section ----
// The organization a repo belongs to, read off its `origin` remote — the owner
// segment of the web URL the server already resolves (`https://host/org/repo`),
// so `anplabs/intranet` and `anplabs/platform` share one org. Keyed by host too:
// two `anplabs` on different forges are two different organizations. A repo with
// no hosted remote has none.
function repoOrg(repoId) {
  const remoteUrl = state.repoRemoteUrlByRepo.get(repoId);
  if (!remoteUrl) return null;
  try {
    const u = new URL(remoteUrl);
    const owner = u.pathname.split('/').filter(Boolean)[0];
    return owner ? { key: `${u.host}/${owner}`, label: owner, remoteUrl } : null;
  } catch { return null; }
}

// Repos in their user-chosen order, with same-organization ones folded into a
// group. A group needs at least two members — nesting a lone repo under its own
// org heading costs a level of indentation and tells you nothing — so the rest
// stay top-level rows exactly where they were. A group sits at the position of
// its first member, keeping the list's drag-ordered feel.
function sidebarOrgEntries(repos) {
  const counts = new Map();
  for (const r of repos) {
    const org = repoOrg(r.id);
    if (org) counts.set(org.key, (counts.get(org.key) || 0) + 1);
  }
  const entries = [];
  const byKey = new Map();
  for (const r of repos) {
    const org = repoOrg(r.id);
    if (!org || counts.get(org.key) < 2) { entries.push({ org: null, repos: [r] }); continue; }
    let entry = byKey.get(org.key);
    if (!entry) { entry = { org, repos: [] }; byKey.set(org.key, entry); entries.push(entry); }
    entry.repos.push(r);
  }
  return entries;
}

// A repo's terminal sessions, nested under its row like a herdr space's tabs.
// Not cards — they have no column and no board state — and clicking one jumps
// straight into that shell.
function sessionsHtml(repoId) {
  const list = sessionsForRepo(repoId);
  if (!list.length) return '';
  const key = `sessions:${repoId}`;
  const shown = expandedGroups.has(key) ? list : list.slice(0, SIDEBAR_MAX_ROWS);
  const activeKey = activeTabKey();
  return `
      <div class="sb-sessions">
        ${shown.map((s) => `
        <button class="sb-session${activeKey === `session:${s.id}` ? ' active' : ''}" data-session="${esc(s.id)}"
                title="${esc(`${s.label} — ${STATUS_LABEL[s.status]}\n${s.cwd}`)}">
          <span class="term-dot ${esc(s.status)}"></span>
          <span class="sb-session-label">${esc(s.label)}</span>
          ${s.status === 'exited' ? '<span class="sb-session-note">closed</span>' : ''}
        </button>`).join('')}
        ${list.length > SIDEBAR_MAX_ROWS ? moreRowHtml(key, list.length) : ''}
      </div>`;
}

// One line per project: avatar, name, the checked-out branch (herdr shows a
// space's branch next to its name), and the status rolled up from its agents.
// `inOrg` drops the avatar: it is the *organization's* avatar (GitHub serves
// one per owner), so under an org heading every row would repeat it.
function projectHtml(r, inOrg, agents) {
  const mine = agents.filter((a) => a.repoId === r.id);
  const st = rollup(mine);
  const active = activeTabKey() === `repo:${r.id}`;
  const avatarUrl = inOrg ? null : githubAvatarUrl(state.repoRemoteUrlByRepo.get(r.id));
  const branch = state.repoBranchByRepo.get(r.id);
  const branchText = branch && branch !== 'loading' ? branch : '';
  const needs = mine.filter((a) => a.state === 'needs').length;
  const working = mine.filter((a) => a.state === 'working').length;
  const tip = [r.path, st ? `${STATE_TEXT[st]}: ${mine.filter((a) => a.state === st).length}` : 'Nothing running'].join('\n');
  return `
      <div class="sb-project">
        <div class="sb-project-row${active ? ' active' : ''}">
          <button class="sb-project-btn" data-repo="${esc(r.id)}" title="${esc(tip)}">
            ${avatarUrl
            ? `<img class="sidebar-avatar" src="${esc(avatarUrl)}" alt="" loading="lazy">`
            : `<span class="sidebar-project-icon">${icon('folder')}</span>`}
            <span class="sb-project-name">${esc(r.name)}</span>
            ${branchText ? `<span class="sb-project-branch">${esc(branchText)}</span>` : ''}
            <span class="sb-project-status">
              ${needs ? `<span class="sb-pill needs">${needs}</span>` : ''}
              ${working ? `<span class="sb-pill working">${working}</span>` : ''}
              ${!needs && !working ? glyph(st, mine.some((a) => a.failed)) : ''}
            </span>
          </button>
          <button class="sb-project-add" data-new-session="${esc(r.id)}"
                  title="New terminal session on ${esc(r.name)}" aria-label="New terminal session on ${esc(r.name)}">${icon('terminal')}</button>
        </div>
        ${sessionsHtml(r.id)}
      </div>`;
}

// An organization and the repos under it. Purely a container: the heading only
// folds the group away — clicking it never changes the workspace, since an org
// isn't a place you can be. Folded, it still shows the group's rolled-up status
// so a project that needs you can't hide inside a closed org.
function orgHtml({ org, repos }, agents) {
  if (!org) return projectHtml(repos[0], false, agents);
  const open = !sidebarOrgCollapsed.has(org.key);
  const ids = new Set(repos.map((r) => r.id));
  const mine = agents.filter((a) => ids.has(a.repoId));
  const avatarUrl = githubAvatarUrl(org.remoteUrl);
  return `
      <div class="sb-org${open ? ' open' : ''}">
        <button class="sb-org-btn" data-org="${esc(org.key)}" aria-expanded="${open}"
                title="${esc(`${org.label} — ${repos.length} repositories`)}">
          <span class="sb-org-twisty">${icon(open ? 'chevron-down' : 'chevron-right')}</span>
          ${avatarUrl
          ? `<img class="sidebar-avatar" src="${esc(avatarUrl)}" alt="" loading="lazy">`
          : `<span class="sidebar-project-icon">${icon('folder')}</span>`}
          <span class="sb-org-name">${esc(org.label)}</span>
          ${open ? `<span class="count">${repos.length}</span>` : glyph(rollup(mine), mine.some((a) => a.failed))}
        </button>
        ${open ? `<div class="sb-org-body">${repos.map((r) => projectHtml(r, true, agents)).join('')}</div>` : ''}
      </div>`;
}

function renderSidebar() {
  const el = $('#sidebar');
  if (!el || !sidebarOn()) return;
  ensureSeen();
  const agents = allAgents();
  // innerHTML rebuild is the same choke point the board uses; keep the scroll
  // position so a live task's SSE tick doesn't yank the list from under you.
  const scroll = el.scrollTop;
  const homeActive = activeTabKey() === 'super';
  el.innerHTML = `
      <button class="sb-home${homeActive ? ' active' : ''}" data-super="1">
        ${icon('layout-grid')}<span>Home</span>
      </button>
      ${agentsSectionHtml(agents)}
      <section class="sb-section" aria-label="Projects">
        <div class="sb-section-head">
          <span class="sb-section-title">Projects</span>
          <button class="sb-section-add" id="sidebar-add-repo" title="Add a repository" aria-label="Add a repository">${icon('plus')}</button>
        </div>
        ${state.repos.length
        ? sidebarOrgEntries(state.repos).map((e) => orgHtml(e, agents)).join('')
        : '<div class="sidebar-empty">No repositories yet.</div>'}
      </section>`;
  el.scrollTop = scroll;
  // Branches and avatars come from the same per-repo lookup the Super View uses.
  for (const r of state.repos) refreshRepoBranchCard(r.id);
}

// Opening a card from another project switches the workspace too, so closing
// the drawer doesn't leave you on an unrelated board.
function openFromRail(kind, id) {
  const item = kind === 'task' ? state.tasks.get(id)
    : kind === 'grooming' ? state.groomings.get(id) : state.orchestrations.get(id);
  if (item && item.repoId && (state.view.mode !== 'workspace' || state.view.repoId !== item.repoId)) {
    enterWorkspace(item.repoId);
  }
  if (kind === 'task') openDrawer(id);
  else if (kind === 'grooming') openGroomingDrawer(id);
  else openOrchestrationDrawer(id);
  // The drawer sets its open id synchronously, so this pass highlights the row.
  renderSidebar();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('#sidebar-add-repo')) { openReposModal(); return; }
    if (e.target.closest('[data-seen-all]')) { markAllSeen(); return; }
    // The project row's terminal button sits inside the row, so it's checked
    // before the project button itself.
    const addSession = e.target.closest('[data-new-session]');
    if (addSession) { openNewSessionMenu(addSession.dataset.newSession, addSession); return; }
    const more = e.target.closest('[data-more]');
    if (more) {
      const key = more.dataset.more;
      if (expandedGroups.has(key)) expandedGroups.delete(key);
      else expandedGroups.add(key);
      renderSidebar();
      return;
    }
    const sessionBtn = e.target.closest('[data-session]');
    if (sessionBtn) { focusSession(sessionBtn.dataset.session); return; }
    const orgBtn = e.target.closest('[data-org]');
    if (orgBtn) {
      const key = orgBtn.dataset.org;
      if (sidebarOrgCollapsed.has(key)) sidebarOrgCollapsed.delete(key);
      else sidebarOrgCollapsed.add(key);
      renderSidebar();
      return;
    }
    if (e.target.closest('[data-super]')) { exitWorkspace(); return; }
    const repoBtn = e.target.closest('[data-repo]');
    if (repoBtn) { enterWorkspace(repoBtn.dataset.repo); return; }
    for (const kind of ['task', 'grooming', 'orchestration']) {
      const row = e.target.closest(`[data-${kind}]`);
      if (row) { openFromRail(kind, row.dataset[kind]); return; }
    }
  });

  // Same right-click menu as the board card, so the sidebar isn't a second-class
  // way to reach a task.
  $('#sidebar').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-task]');
    if (!row) return;
    const t = state.tasks.get(row.dataset.task);
    if (!t) return;
    e.preventDefault();
    openContextMenu(t, e.clientX, e.clientY);
  });
}


export { markSeen, renderSidebar };

/* Ployd — settings-modal. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderPlugins } from './autonomous.js';
import { editorById, editors, loadDesktop, syncDesktopLabels } from './desktop.js';
import { renderCustomModels } from './models.js';
import { renderRemoteAccess } from './remote.js';
import { resourceMonitorOn } from './resources.js';
import { notificationsOn, updateNotifNote } from './settings.js';
import { soundsOn } from './sounds.js';
import { currentLayout, currentPalette, currentTheme } from './theme.js';
import { loadUsage, usageRepoOptionsHtml } from './usage.js';


// ---------- settings modal ----------
function showSettingsSection(name) {
  for (const item of document.querySelectorAll('.settings-nav-item')) {
    const on = item.dataset.section === name;
    item.classList.toggle('active', on);
    if (on) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
    // The content pane's fixed header names the open section, so the title
    // sits in one place instead of scrolling away with each section's body.
    if (on) $('#settings-section-title').textContent = item.textContent.trim();
  }
  for (const sec of document.querySelectorAll('.settings-section')) {
    sec.classList.toggle('hidden', sec.dataset.section !== name);
  }
  if (name === 'usage') {
    const select = $('#usage-repo-filter');
    const prev = select.value;
    select.innerHTML = usageRepoOptionsHtml();
    select.value = state.repos.some((r) => r.id === prev) ? prev : '';
    loadUsage();
  }
}

// The per-session memory budget + MCP isolation controls. "Auto" is labeled
// with what it actually works out to on this machine (the server derives it
// from total RAM and the parallel-session cap), so the choice is legible.
function renderSessionMemorySetting() {
  const auto = state.settings.sessionMemoryAutoMb;
  const autoOption = $('#setting-session-memory').querySelector('option[value="auto"]');
  autoOption.textContent = auto ? `Auto (${(auto / 1024).toFixed(auto % 1024 ? 1 : 0)} GB per session)` : 'Auto';
  const value = state.settings.sessionMemoryMb;
  $('#setting-session-memory').value = value === undefined || value === 'auto' ? 'auto' : String(value);
  $('#setting-isolate-mcp').checked = state.settings.isolateMcpServers !== false;
  // Detached runs: a POSIX feature, so on Windows the box is shown disabled
  // with the line that says why (the server ignores the setting there anyway).
  const supported = state.settings.detachedRunsSupported !== false;
  $('#setting-detached-runs').checked = supported && !!state.settings.detachedRuns;
  $('#setting-detached-runs').disabled = !supported;
  $('#setting-detached-runs-windows').hidden = supported;
}

// `section` may be a string ('general' | 'plugins') or a DOM event (from the
// header button); anything non-string falls back to the General section.
function openSettingsModal(section) {
  $('#setting-notifications').checked = notificationsOn();
  $('#setting-sounds').checked = soundsOn();
  updateNotifNote();
  $('#setting-max-parallel').value = state.settings.maxParallelSessions || 3;
  $('#setting-merge-strategy').value = state.settings.mergeStrategy || 'merge';
  $('#setting-min-merge-grade').value = String(state.settings.minMergeGrade || 4);
  $('#setting-auto-resolve-conflicts').checked = !!state.settings.autoResolveConflicts;
  $('#setting-assign-pr-to-self').checked = !!state.settings.assignPrToSelf;
  $('#setting-memory').checked = !!state.settings.memory;
  $('#setting-resource-monitor').checked = resourceMonitorOn();
  $('#setting-notify-sessions').checked = state.settings.notifySessions !== false;
  renderSessionMemorySetting();
  $('#setting-theme').value = currentTheme();
  $('#setting-palette').value = currentPalette();
  $('#setting-layout').value = currentLayout();
  renderEditorSetting();
  renderSessionAgentsSetting();
  renderPlugins();
  renderCustomModels();
  renderRemoteAccess();
  showSettingsSection(typeof section === 'string' ? section : 'general');
  $('#modal-settings').classList.remove('hidden');
}

async function saveSettings(patch) {
  try {
    state.settings = await api('PATCH', '/api/settings', patch);
  } catch (e) { toast(e.message); }
}

// ---------- default IDE (Settings → General → External tools) ----------
// The <select> lists every editor Ployd knows how to launch; the ones it
// can't find on this machine stay selectable but are marked, so choosing one
// (e.g. before installing its launcher) is possible without being a trap.
function renderEditorSetting() {
  const sel = $('#setting-default-editor');
  if (!sel) return;
  const current = state.settings.defaultEditor || '';
  const options = editors().map((e) => `<option value="${esc(e.id)}"${e.available ? '' : ' data-missing="1"'}>${esc(e.label)}${e.available ? '' : ' — not found'}</option>`).join('');
  sel.innerHTML = `<option value="">Ask me each time</option>${options}`;
  // A default naming an editor this machine doesn't have would silently fail on
  // click; keep it selected anyway (it may be a shared db.json / a pending
  // install) — the note below spells out why nothing happens.
  if (current && !editors().some((e) => e.id === current)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(current)}">${esc(current)} — unknown</option>`);
  }
  sel.value = current;
  // Warn when the chosen editor isn't installed here — otherwise clicking
  // "Open in IDE" would just toast an error with no hint of why. The note joins
  // the row's description, under the label it explains.
  $('#setting-editor-missing')?.remove();
  const chosen = editorById(current);
  if (chosen && !chosen.available) {
    sel.closest('.settings-row').querySelector('.settings-row-text').insertAdjacentHTML('beforeend',
      `<p class="settings-row-desc warn" id="setting-editor-missing">${icon('triangle-alert')} <span>${esc(chosen.label)} isn't on this machine yet. ${esc(chosen.hint)}</span></p>`);
  }
}

// ---------- custom session agents (Settings → General → Session agents) ----------
// The user's own agent commands for terminal sessions. Each row edits in place
// and saves the whole list on change; the server sanitizes it (drops a row with
// no name or command, mints ids) and the new-session picker reads it straight
// from state.settings. The mark beside a row says whether its program was found
// on PATH — a hint only, since the login shell may still resolve an alias.
const sessionAgents = () => state.settings.sessionAgents || [];

function sessionAgentRowHtml(a, found) {
  const tip = found
    ? 'Found on this machine’s PATH'
    : 'Not found on this machine’s PATH. It is still offered: your login shell may know it as an alias or function.';
  return `
      <div class="session-agent-row" data-id="${esc(a.id)}">
        <input type="text" maxlength="40" value="${esc(a.label)}" data-field="label" aria-label="Name of ${esc(a.label)}" />
        <input class="mono" type="text" maxlength="500" value="${esc(a.command)}" data-field="command" aria-label="Command for ${esc(a.label)}" />
        <span class="session-agent-found${found ? '' : ' missing'}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(found ? 'check' : 'triangle-alert')}</span>
        <button class="btn icon danger session-agent-remove" title="Remove" aria-label="Remove ${esc(a.label)}">${icon('trash')}</button>
      </div>`;
}

// Re-rendered on every settings broadcast while the modal is open, so a field
// being typed into keeps its focus, caret and unsaved text across the redraw.
function renderSessionAgentsSetting() {
  const body = $('#session-agents-body');
  if (!body) return;
  const active = document.activeElement;
  const keep = active && body.contains(active) && active.dataset.field
    ? { id: active.closest('.session-agent-row')?.dataset.id, field: active.dataset.field,
      value: active.value, start: active.selectionStart, end: active.selectionEnd }
    : null;
  const found = state.settings.sessionAgentsFound || {};
  body.innerHTML = sessionAgents().map((a) => sessionAgentRowHtml(a, !!found[a.id])).join('');
  if (!keep) return;
  const row = [...body.querySelectorAll('.session-agent-row')].find((r) => r.dataset.id === keep.id);
  const el = row?.querySelector(`[data-field="${keep.field}"]`);
  if (!el) return;
  el.value = keep.value;
  el.focus();
  try { el.setSelectionRange(keep.start, keep.end); } catch (_) { /* not a text field */ }
}

async function setSessionAgents(list) {
  await saveSettings({ sessionAgents: list });
  renderSessionAgentsSetting();
}

async function addSessionAgent() {
  const label = $('#session-agent-add-label').value.trim();
  const command = $('#session-agent-add-command').value.trim();
  if (!label || !command) { toast('An agent needs a name and a command.'); return; }
  await setSessionAgents([...sessionAgents(), { label, command }]);
  $('#session-agent-add-label').value = '';
  $('#session-agent-add-command').value = '';
  $('#session-agent-add-label').focus();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#session-agent-add-btn').addEventListener('click', addSessionAgent);
  for (const sel of ['#session-agent-add-label', '#session-agent-add-command']) {
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addSessionAgent(); }
    });
  }
  $('#session-agents-body').addEventListener('change', async (e) => {
    const field = e.target.dataset?.field;
    const row = e.target.closest('.session-agent-row');
    if (!field || !row) return;
    const value = e.target.value.trim();
    const current = sessionAgents().find((a) => a.id === row.dataset.id);
    if (!current) return;
    if (!value) {
      toast('An agent needs a name and a command.');
      e.target.value = current[field];
      return;
    }
    await setSessionAgents(sessionAgents().map((a) => (a.id === current.id ? { ...a, [field]: value } : a)));
  });
  $('#session-agents-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('.session-agent-remove');
    if (!btn) return;
    const id = btn.closest('.session-agent-row').dataset.id;
    await setSessionAgents(sessionAgents().filter((a) => a.id !== id));
  });

  $('#setting-default-editor').addEventListener('change', async (e) => {
    await saveSettings({ defaultEditor: e.target.value });
    syncDesktopLabels();
    renderEditorSetting();
  });
  $('#setting-editor-rescan').addEventListener('click', async () => {
    await loadDesktop(true);
    const found = editors().filter((x) => x.available).length;
    toast(found ? `Found ${found} editor${found === 1 ? '' : 's'}` : 'No supported editor found', 'info');
  });
}


export { openSettingsModal, renderEditorSetting, renderSessionAgentsSetting, renderSessionMemorySetting, saveSettings, showSettingsSection };

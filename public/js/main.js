// App shell: session, data loading, header, tabs and view switching.

import * as api from './api.js';
import { loadGameData, loadTeam } from './data.js';
import { normalizePositions, sameLineup } from './rules.js';
import { esc, num, countdown, deadlineText, toast, openModal, closeModal } from './ui.js';
import * as connectView from './views/connect.js';
import * as teamView from './views/team.js';
import * as transfersView from './views/transfers.js';
import * as pointsView from './views/points.js';
import * as fixturesView from './views/fixtures.js';

const VIEWS = {
  team: { label: 'Pick Team', mod: teamView },
  transfers: { label: 'Transfers', mod: transfersView },
  points: { label: 'Points', mod: pointsView },
  fixtures: { label: 'Fixtures', mod: fixturesView },
};

const pref = {
  get(key) { try { return localStorage.getItem(`fplm.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`fplm.${key}`, value); } catch { /* storage unavailable */ } },
};

export const app = {
  session: null,
  d: null,
  team: null,
  view: VIEWS[pref.get('view')] ? pref.get('view') : 'team',
  lineup: null,
  transfer: null,
  status: 'starting',
  error: null,
  render,
  reload,
  resetPlans,
  dirty,
  pref,
};

const $view = document.getElementById('view');
const $header = document.getElementById('header');
const $tabs = document.getElementById('tabs');

function teamChip(team) {
  return ['bboost', '3xc'].includes(team.activeChip) ? team.activeChip : null;
}

function resetPlans() {
  const picks = normalizePositions(app.team.picks, app.d.typeOf);
  app.lineup = { original: picks, picks, chip: teamChip(app.team), originalChip: teamChip(app.team), selected: null };
  app.transfer = {
    pending: [],
    outId: null,
    chip: null,
    free: null,
    filters: app.transfer?.filters ?? { q: '', type: 0, team: 0, maxPrice: '', sort: 'total_points', available: false },
  };
}

function dirty() {
  if (!app.lineup || !app.transfer) return false;
  return app.transfer.pending.length > 0 || !sameLineup(app.lineup.picks, app.lineup.original) || app.lineup.chip !== app.lineup.originalChip;
}

async function reload({ keepPlans = false } = {}) {
  app.status = 'loading';
  app.error = null;
  render();
  try {
    app.d = await loadGameData();
    app.team = await loadTeam(app.session, app.d);
    if (!keepPlans || !app.lineup) resetPlans();
    app.status = 'ready';
  } catch (err) {
    app.status = 'error';
    app.error = err;
  }
  render();
}

function renderHeader() {
  const s = app.session;
  const entry = app.team?.entry;
  const next = app.d?.next;
  const modeLabel = !s?.connected ? '' : s.demo ? 'Demo' : s.mode === 'auth' ? 'Logged in' : 'View only';
  $header.innerHTML = `
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>FPL Manager</span></div>
    ${entry ? `<div class="hdr-team"><strong>${esc(entry.name)}</strong><span class="muted">${num(entry.summary_overall_points)} pts · Rank ${num(entry.summary_overall_rank)}</span></div>` : '<div class="hdr-team"></div>'}
    ${next ? `<div class="hdr-deadline" title="${esc(deadlineText(next.deadline_time))}"><span class="muted">GW${esc(next.id)} deadline</span><strong data-countdown="${esc(next.deadline_time)}">${esc(countdown(next.deadline_time))}</strong></div>` : ''}
    ${s?.connected ? `<button class="account-btn" data-action="account"><span class="dot ${s.mode === 'auth' ? 'dot-on' : ''}"></span>${esc(modeLabel)}</button>` : ''}`;
}

function renderTabs() {
  if (app.status !== 'ready' || !app.session?.connected) { $tabs.hidden = true; return; }
  $tabs.hidden = false;
  $tabs.innerHTML = Object.entries(VIEWS).map(([key, v]) => {
    let badge = '';
    if (key === 'transfers' && app.transfer?.pending.length) badge = `<span class="badge">${app.transfer.pending.length}</span>`;
    if (key === 'team' && app.lineup && (!sameLineup(app.lineup.picks, app.lineup.original) || app.lineup.chip !== app.lineup.originalChip)) badge = '<span class="badge badge-dot" aria-label="unsaved changes"></span>';
    return `<button role="tab" data-view="${key}" aria-selected="${app.view === key}">${esc(v.label)}${badge}</button>`;
  }).join('');
}

function renderStatus() {
  if (app.status === 'loading' || app.status === 'starting') {
    $view.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading your team…</p></div>';
    return;
  }
  const err = app.error;
  const loginProblem = err?.status === 401 || err?.status === 403;
  $view.innerHTML = `<div class="empty-state">
      <h2>${loginProblem ? 'Your FPL login needs refreshing' : "Couldn't load your team"}</h2>
      <p>${esc(err?.message ?? 'Unknown error')}</p>
      <div class="row-gap">
        <button class="btn btn-primary" data-action="retry">Try again</button>
        <button class="btn" data-action="disconnect">${loginProblem ? 'Log in again' : 'Change account'}</button>
      </div>
    </div>`;
  $view.onclick = (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'retry') reload();
    if (a === 'disconnect') disconnect();
  };
}

function render() {
  $view.onclick = null;
  $view.oninput = null;
  $view.onchange = null;
  $view.onsubmit = null;
  renderHeader();
  renderTabs();
  if (!app.session) return renderStatus();
  if (!app.session.connected) {
    $tabs.hidden = true;
    connectView.render($view, app, { onConnected });
    return;
  }
  if (app.status !== 'ready') return renderStatus();
  VIEWS[app.view].mod.render($view, app);
}

async function onConnected(session) {
  app.session = session;
  app.lineup = null;
  app.transfer = null;
  await reload();
}

async function disconnect() {
  if (dirty() && !window.confirm('You have unsaved changes. Disconnect anyway?')) return;
  closeModal();
  try {
    app.session = await api.disconnect();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  app.team = null;
  app.d = null;
  app.lineup = null;
  app.transfer = null;
  app.status = 'ready';
  render();
}

function openAccount() {
  const s = app.session;
  const expires = s.expiresAt ? new Date(s.expiresAt * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const how = s.demo
    ? '<p class="note">Demo mode: a pretend league running on your computer. Nothing is sent to FPL.</p>'
    : s.mode === 'auth'
      ? `<p>Logged in${s.name ? ` as <strong>${esc(s.name)}</strong>` : ''} · team ID ${esc(s.entry)}.</p>
         <p class="muted small">${s.canRefresh ? 'Your login renews itself automatically for about a month.' : `Your login lasts until about ${esc(expires ?? 'it expires')}. After that, paste a new one.`}</p>`
      : `<p>Viewing team ID <strong>${esc(s.entry)}</strong> without logging in. You can plan changes, but saving them needs a login.</p>`;
  openModal({
    title: 'Account',
    body: how,
    footer: `<button class="btn" data-action="reload">Reload data</button><button class="btn btn-danger" data-action="disconnect">${s.mode === 'auth' ? 'Log out' : 'Change team'}</button>`,
    actions: {
      reload: () => { closeModal(); reload({ keepPlans: true }); },
      disconnect: () => disconnect(),
    },
  });
}

$header.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="account"]')) openAccount();
});

$tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  app.view = btn.dataset.view;
  pref.set('view', app.view);
  render();
  window.scrollTo({ top: 0 });
});

window.addEventListener('beforeunload', (e) => {
  if (dirty()) { e.preventDefault(); e.returnValue = ''; }
});

setInterval(() => {
  for (const node of document.querySelectorAll('[data-countdown]')) node.textContent = countdown(node.dataset.countdown);
}, 20_000);

(async function start() {
  render();
  try {
    app.session = await api.getSession();
  } catch (err) {
    $view.innerHTML = `<div class="empty-state"><h2>Can't reach the FPL Manager server</h2><p>${esc(err.message)}</p><p class="muted">Make sure <code>npm start</code> is still running, then reload this page.</p></div>`;
    return;
  }
  if (app.session.connected) await reload();
  else { app.status = 'ready'; render(); }
})();

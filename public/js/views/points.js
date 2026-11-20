// Points: how your team scored in a gameweek, player by player.

import * as api from '../api.js';
import { starterPicks, benchPicks } from '../rules.js';
import { esc, num, toast } from '../ui.js';
import { playerCard, openPlayer } from './player.js';

const cache = new Map();

async function loadGameweek(app, gw) {
  const key = `${app.session.entry}:${gw}`;
  if (!cache.has(key)) {
    cache.set(key, Promise.all([
      api.fpl(`entry/${app.session.entry}/event/${gw}/picks/`),
      api.fpl(`event/${gw}/live/`),
    ]).then(([picks, live]) => ({ picks, live: new Map((live.elements ?? []).map((e) => [e.id, e.stats])) }))
      .catch((err) => { cache.delete(key); throw err; }));
  }
  return cache.get(key);
}

export function render(root, app) {
  const { d, team } = app;
  const latest = d.current?.id ?? null;
  if (!latest) {
    root.innerHTML = '<div class="empty-state"><h2>No points yet</h2><p>Points appear here once the first gameweek starts.</p></div>';
    return;
  }
  const first = Math.max(1, team.entry?.started_event ?? 1);
  if (!app.pointsEvent || app.pointsEvent > latest || app.pointsEvent < first) app.pointsEvent = latest;
  const gw = app.pointsEvent;
  const event = d.events.find((e) => e.id === gw);

  root.innerHTML = `
    <section class="view view-points">
      <div class="view-head">
        <div>
          <h1>Points</h1>
          <p class="muted">${esc(event?.name ?? `Gameweek ${gw}`)}${event && !event.finished ? ' · in progress' : ''}</p>
        </div>
        <div class="gw-nav">
          <button class="btn btn-small" data-gw="${gw - 1}" ${gw <= first ? 'disabled' : ''} aria-label="Previous gameweek">‹ GW${gw - 1}</button>
          <button class="btn btn-small" data-gw="${gw + 1}" ${gw >= latest ? 'disabled' : ''} aria-label="Next gameweek">GW${gw + 1} ›</button>
        </div>
      </div>
      <div data-points><div class="loading"><div class="spinner"></div></div></div>
    </section>`;

  root.onclick = (e) => {
    const nav = e.target.closest('[data-gw]');
    if (nav) { app.pointsEvent = Number(nav.dataset.gw); app.render(); return; }
    const card = e.target.closest('.pcard');
    if (card) openPlayer(app, Number(card.dataset.id));
  };

  loadGameweek(app, gw).then(({ picks, live }) => {
    if (app.view !== 'points' || app.pointsEvent !== gw) return;
    const box = root.querySelector('[data-points]');
    const hist = picks.entry_history ?? {};
    const all = (picks.picks ?? []).map((p) => ({ ...p }));
    const pts = (p) => live.get(p.element)?.total_points ?? 0;
    const card = (p) => {
      const raw = pts(p);
      const shown = p.multiplier > 0 ? raw * p.multiplier : raw;
      return playerCard(app, p.element, {
        label: `${shown} pt${shown === 1 ? '' : 's'}`,
        labelClass: p.multiplier === 0 ? 'pts-tag pts-bench' : 'pts-tag',
        captain: p.is_captain,
        vice: p.is_vice_captain,
      });
    };
    const starters = starterPicks(all);
    const rows = [1, 2, 3, 4].map((type) => `<div class="pitch-row">${starters.filter((p) => d.typeOf(p.element) === type).map(card).join('')}</div>`).join('');
    const subs = (picks.automatic_subs ?? []).map((s) => `<li>${esc(d.elements.get(s.element_out)?.web_name)} → ${esc(d.elements.get(s.element_in)?.web_name)}</li>`).join('');
    const chipNames = { bboost: 'Bench Boost', '3xc': 'Triple Captain', wildcard: 'Wildcard', freehit: 'Free Hit', manager: 'Assistant Manager' };
    box.innerHTML = `
      <div class="stat-strip">
        <div class="stat-big"><span>Points</span><strong>${esc(hist.points ?? '–')}</strong></div>
        <div><span>Average</span><strong>${esc(event?.average_entry_score ?? '–')}</strong></div>
        <div><span>Highest</span><strong>${esc(event?.highest_score ?? '–')}</strong></div>
        <div><span>GW rank</span><strong>${hist.rank ? esc(num(hist.rank)) : '–'}</strong></div>
        <div><span>Transfers</span><strong>${esc(hist.event_transfers ?? 0)}${hist.event_transfers_cost ? ` <span class="text-bad">(-${esc(hist.event_transfers_cost)})</span>` : ''}</strong></div>
        <div><span>Bench</span><strong>${esc(hist.points_on_bench ?? 0)}</strong></div>
      </div>
      ${picks.active_chip ? `<p class="note">${esc(chipNames[picks.active_chip] ?? picks.active_chip)} played this gameweek.</p>` : ''}
      <div class="pitch">
        <div class="pitch-lines" aria-hidden="true"></div>
        ${rows}
      </div>
      <div class="bench"><div class="bench-label">Substitutes</div><div class="pitch-row">${benchPicks(all).map(card).join('')}</div></div>
      ${subs ? `<div class="card"><h3 class="section-title">Automatic substitutions</h3><ul class="plain">${subs}</ul></div>` : ''}`;
  }).catch((err) => {
    const box = root.querySelector('[data-points]');
    if (box) box.innerHTML = `<div class="empty-state"><p>${esc(err.message)}</p></div>`;
    if (err.status !== 404) toast(err.message, 'error');
  });
}

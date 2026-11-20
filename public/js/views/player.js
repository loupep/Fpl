// Player cards on the pitch and the player details dialog.

import * as api from '../api.js';
import { upcoming, fixturesFor } from '../data.js';
import { esc, money, shirt, statusFlag, fixtureText, fdrClass, openModal, posShort, num } from '../ui.js';

export function nextFixtureLabel(app, el) {
  const list = app.d.next ? fixturesFor(app.d, el.team, app.d.next.id) : [];
  return { text: fixtureText(list, app.d.teams), cls: fdrClass(list) };
}

export function playerCard(app, id, { label, labelClass = '', classes = '', captain = false, vice = false, tag = '' } = {}) {
  const el = app.d.elements.get(id);
  if (!el) return '';
  const team = app.d.teams.get(el.team);
  const fx = label === undefined ? nextFixtureLabel(app, el) : { text: label, cls: labelClass };
  const armband = captain ? '<span class="armband" title="Captain">C</span>' : vice ? '<span class="armband armband-vice" title="Vice-captain">V</span>' : '';
  return `<button type="button" class="pcard ${classes}" data-id="${id}" aria-label="${esc(`${el.web_name}, ${team?.short_name ?? ''} ${posShort(el.element_type)}${captain ? ', captain' : vice ? ', vice-captain' : ''}`)}">
      ${statusFlag(el)}${armband}${tag}
      ${shirt(team, el.element_type === 1)}
      <span class="pname">${esc(el.web_name)}</span>
      <span class="pmeta ${fx.cls}">${esc(fx.text)}</span>
    </button>`;
}

function fixtureChips(app, el, count = 5) {
  return upcoming(app.d, el.team, count).map(({ event, fixtures }) => {
    const opp = fixtures.length
      ? fixtures.map((f) => `${esc(app.d.teams.get(f.opp)?.short_name ?? '?')}<small>${f.home ? 'H' : 'A'}</small>`).join('<br>')
      : '–';
    return `<div class="fx-chip ${fdrClass(fixtures)}"><span class="fx-gw">GW${event}</span><span class="fx-opp">${opp}</span></div>`;
  }).join('');
}

// actions: [{ name, label, kind?: 'primary'|'danger', disabled?: bool, hint?: string, handler }]
export function openPlayer(app, id, { actions = [], note = '' } = {}) {
  const el = app.d.elements.get(id);
  if (!el) return;
  const team = app.d.teams.get(el.team);
  const stat = (label, value) => `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  const body = `
    <div class="pd-head">
      ${shirt(team, el.element_type === 1)}
      <div>
        <div class="pd-name">${esc(`${el.first_name} ${el.second_name}`)}</div>
        <div class="muted">${esc(team?.name ?? '')} · ${esc(posShort(el.element_type))} · ${esc(money(el.now_cost))}</div>
      </div>
    </div>
    ${el.status !== 'a' || el.news ? `<p class="news ${el.status === 'd' && el.chance_of_playing_next_round ? 'news-warn' : 'news-bad'}">${esc(el.news || 'Not available')}</p>` : ''}
    ${note ? `<p class="note">${note}</p>` : ''}
    <div class="stats">
      ${stat('Total points', el.total_points)}
      ${stat('Form', el.form)}
      ${stat('Points / match', el.points_per_game)}
      ${stat('Selected by', `${el.selected_by_percent}%`)}
      ${stat('Goals', el.goals_scored)}
      ${stat('Assists', el.assists)}
      ${stat(el.element_type <= 2 ? 'Clean sheets' : 'xGI', el.element_type <= 2 ? el.clean_sheets : el.expected_goal_involvements ?? '–')}
      ${stat('Minutes', num(el.minutes))}
    </div>
    <h3 class="section-title">Next fixtures</h3>
    <div class="fx-row">${fixtureChips(app, el)}</div>
    <h3 class="section-title">Recent gameweeks</h3>
    <div class="history" data-history><span class="muted small">Loading…</span></div>`;
  const footer = actions.map((a) => `<button class="btn ${a.kind ? `btn-${a.kind}` : ''}" data-action="${esc(a.name)}" ${a.disabled ? 'disabled' : ''} ${a.hint ? `title="${esc(a.hint)}"` : ''}>${esc(a.label)}</button>`).join('');
  const node = openModal({
    title: el.web_name,
    body,
    footer,
    actions: Object.fromEntries(actions.map((a) => [a.name, a.handler])),
    className: 'player-modal',
  });

  api.fpl(`element-summary/${id}/`).then((summary) => {
    const box = node.querySelector('[data-history]');
    if (!box) return;
    const rows = (summary.history ?? []).slice(-5).reverse();
    if (!rows.length) { box.innerHTML = '<span class="muted small">No games yet this season.</span>'; return; }
    box.innerHTML = `<table class="mini-table"><thead><tr><th>GW</th><th>Opponent</th><th>Result</th><th>Mins</th><th>Pts</th></tr></thead><tbody>${rows.map((h) => {
      const opp = app.d.teams.get(h.opponent_team)?.short_name ?? '?';
      const score = h.team_h_score == null ? '' : `${h.team_h_score}-${h.team_a_score}`;
      return `<tr><td>${esc(h.round)}</td><td>${esc(opp)} (${h.was_home ? 'H' : 'A'})</td><td>${esc(score)}</td><td>${esc(h.minutes)}</td><td><strong>${esc(h.total_points)}</strong></td></tr>`;
    }).join('')}</tbody></table>`;
  }).catch(() => {
    const box = node.querySelector('[data-history]');
    if (box) box.innerHTML = '<span class="muted small">Couldn\'t load recent games.</span>';
  });
}

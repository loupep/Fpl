// Pick Team: choose the starting XI, bench order, captain and vice-captain,
// and play Bench Boost or Triple Captain.

import * as api from '../api.js';
import { chipsFor } from '../data.js';
import {
  canSwap, swapPlayers, setCaptain, setViceCaptain, starterPicks, benchPicks, formation,
  lineupProblems, lineupPayload, sameLineup, validateXI, POSITIONS,
} from '../rules.js';
import { esc, deadlineText, toast, busy, confirmModal, closeModal } from '../ui.js';
import { playerCard, openPlayer } from './player.js';

const TEAM_CHIPS = ['bboost', '3xc'];
const CHIP_HELP = {
  bboost: 'Points scored by your four substitutes count too, this gameweek only.',
  '3xc': 'Your captain scores triple points instead of double, this gameweek only.',
};

function swapBlockReason(app, aId, bId) {
  const { picks } = app.lineup;
  const { typeOf, rules } = app.d;
  const a = picks.find((p) => p.element === aId);
  const b = picks.find((p) => p.element === bId);
  if (!a || !b || aId === bId) return null;
  const aStarts = a.position <= 11;
  const bStarts = b.position <= 11;
  if (aStarts && bStarts) return 'Pick a substitute to swap with.';
  if ((typeOf(aId) === 1) !== (typeOf(bId) === 1)) return 'Goalkeepers can only swap with goalkeepers.';
  if (aStarts !== bStarts) {
    const [starter, sub] = aStarts ? [a, b] : [b, a];
    const xi = starterPicks(picks).map((p) => (p.element === starter.element ? sub.element : p.element));
    return validateXI(xi, typeOf, rules).reason ?? null;
  }
  return null;
}

export function render(root, app) {
  const { d, team, lineup } = app;
  const { picks, selected } = lineup;
  const next = d.next;
  if (!next) {
    root.innerHTML = '<div class="empty-state"><h2>The season is over</h2><p>There are no more gameweeks to pick a team for.</p></div>';
    return;
  }
  const starters = starterPicks(picks);
  const bench = benchPicks(picks);
  const problems = lineupProblems(picks, d.typeOf, d.rules);
  const changed = !sameLineup(picks, lineup.original) || lineup.chip !== lineup.originalChip;
  const chips = chipsFor(team, next.id);
  const transferChipActive = ['wildcard', 'freehit'].includes(team.activeChip) ? team.activeChip : null;

  const cardFor = (p, benchIndex = null) => {
    let classes = '';
    if (selected != null) {
      if (p.element === selected) classes = 'is-selected';
      else if (canSwap(picks, selected, p.element, d.typeOf, d.rules)) classes = 'is-target';
      else classes = 'is-dim';
    }
    const tag = benchIndex == null ? '' : `<span class="bench-no">${benchIndex === 0 ? 'GK' : benchIndex}</span>`;
    return playerCard(app, p.element, { classes, captain: p.is_captain, vice: p.is_vice_captain, tag });
  };

  const rows = [1, 2, 3, 4].map((type) => `<div class="pitch-row">${starters.filter((p) => d.typeOf(p.element) === type).map((p) => cardFor(p)).join('')}</div>`).join('');
  const selectedEl = selected != null ? d.elements.get(selected) : null;

  const chipButtons = TEAM_CHIPS.filter((name) => chips.has(name)).map((name) => {
    const c = chips.get(name);
    const on = lineup.chip === name;
    const played = c.status_for_entry === 'played';
    const blocked = !on && (Boolean(lineup.chip) || Boolean(transferChipActive));
    const unavailable = c.status_for_entry !== 'available' && c.status_for_entry !== 'active';
    const state = on ? 'Active' : played ? `Played${c.played_by_entry?.length ? ` GW${c.played_by_entry.at(-1)}` : ''}` : unavailable ? 'Unavailable' : 'Play';
    const disabled = !team.editable || (!on && (played || unavailable || blocked));
    const title = !team.editable ? 'Log in to play chips' : blocked ? 'You can only play one chip per gameweek' : CHIP_HELP[name];
    return `<button class="chip-btn ${on ? 'is-on' : ''}" data-chip="${name}" ${disabled ? 'disabled' : ''} title="${esc(title)}"><span>${esc(c.label)}</span><small>${esc(state)}</small></button>`;
  }).join('');

  root.innerHTML = `
    <section class="view view-team">
      <div class="view-head">
        <div>
          <h1>Pick Team</h1>
          <p class="muted">${esc(next.name)} · Deadline ${esc(deadlineText(next.deadline_time))} · Formation <strong>${esc(formation(picks, d.typeOf))}</strong></p>
        </div>
        ${chipButtons ? `<div class="chip-bar">${chipButtons}</div>` : ''}
      </div>
      ${!team.editable ? `<p class="note">View only: this is your squad from Gameweek ${esc(team.viewEvent)}. You can try out changes here, but saving needs a login.</p>` : ''}
      ${transferChipActive ? `<p class="note">${transferChipActive === 'wildcard' ? 'Wildcard' : 'Free Hit'} is active this gameweek.</p>` : ''}
      ${selectedEl ? `<div class="banner" role="status"><span>Choose who swaps with <strong>${esc(selectedEl.web_name)}</strong>. Highlighted players are allowed.</span><button class="btn btn-small" data-action="cancel-sub">Cancel</button></div>` : '<p class="hint">Tap a player to substitute them or make them captain.</p>'}
      <div class="pitch">
        <div class="pitch-lines" aria-hidden="true"></div>
        ${rows}
      </div>
      <div class="bench ${lineup.chip === 'bboost' ? 'is-boosted' : ''}">
        <div class="bench-label">Substitutes${lineup.chip === 'bboost' ? ' · Bench Boost on' : ''}</div>
        <div class="pitch-row">${bench.map((p, i) => cardFor(p, i)).join('')}</div>
      </div>
      <div class="action-bar" ${selected != null ? 'hidden' : ''}>
        <div class="action-msg">${problems.length ? `<span class="text-bad">${esc(problems[0])}</span>` : changed ? '<span>You have unsaved changes.</span>' : '<span class="muted">No changes.</span>'}</div>
        <div class="row-gap">
          <button class="btn" data-action="reset" ${changed ? '' : 'disabled'}>Reset</button>
          <button class="btn btn-primary" data-action="save" ${changed && !problems.length && team.editable ? '' : 'disabled'} ${team.editable ? '' : 'title="Log in to save"'}>Save team</button>
        </div>
      </div>
    </section>`;

  root.onclick = async (e) => {
    const card = e.target.closest('.pcard');
    const action = e.target.closest('[data-action]')?.dataset.action;
    const chipBtn = e.target.closest('[data-chip]');

    if (card) {
      const id = Number(card.dataset.id);
      if (lineup.selected != null) {
        if (id === lineup.selected) {
          lineup.selected = null;
        } else if (canSwap(lineup.picks, lineup.selected, id, d.typeOf, d.rules)) {
          lineup.picks = swapPlayers(lineup.picks, lineup.selected, id, d.typeOf);
          lineup.selected = null;
        } else {
          toast(swapBlockReason(app, lineup.selected, id) ?? "Those players can't swap.", 'error');
          return;
        }
        app.render();
        return;
      }
      openActions(app, id);
      return;
    }
    if (action === 'cancel-sub') { lineup.selected = null; app.render(); return; }
    if (action === 'reset') {
      lineup.picks = lineup.original;
      lineup.chip = lineup.originalChip;
      lineup.selected = null;
      app.render();
      return;
    }
    if (action === 'save') { await save(app, e.target.closest('button')); return; }
    if (chipBtn) {
      const name = chipBtn.dataset.chip;
      if (lineup.chip === name) {
        lineup.chip = null;
      } else {
        const c = chips.get(name);
        const ok = await confirmModal({
          title: `Play ${c.label}?`,
          body: `<p>${esc(CHIP_HELP[name])}</p><p class="muted">It is played when you press <strong>Save team</strong>. You only have one ${esc(c.label)} for this half of the season.</p>`,
          confirmLabel: `Use ${c.label}`,
        });
        if (!ok) return;
        lineup.chip = name;
      }
      app.render();
    }
  };
}

function openActions(app, id) {
  const { lineup, d } = app;
  const pick = lineup.picks.find((p) => p.element === id);
  const starting = pick.position <= 11;
  const el = d.elements.get(id);
  const actions = [
    {
      name: 'sub',
      label: 'Substitute',
      kind: 'primary',
      handler: () => { closeModal(); lineup.selected = id; app.render(); },
    },
  ];
  if (starting) {
    actions.push(
      { name: 'cap', label: 'Make captain', disabled: pick.is_captain, handler: () => { closeModal(); lineup.picks = setCaptain(lineup.picks, id); app.render(); } },
      { name: 'vice', label: 'Make vice-captain', disabled: pick.is_vice_captain, handler: () => { closeModal(); lineup.picks = setViceCaptain(lineup.picks, id); app.render(); } },
    );
  }
  const where = starting ? 'Starting' : `Substitute (${pick.position === 12 ? 'goalkeeper' : `bench ${pick.position - 12}`})`;
  openPlayer(app, id, { actions, note: `${esc(where)} · ${esc(POSITIONS[el.element_type].name)}${pick.is_captain ? ' · Captain' : pick.is_vice_captain ? ' · Vice-captain' : ''}` });
}

async function save(app, button) {
  const { lineup, session } = app;
  const cancellingChip = lineup.originalChip && lineup.chip !== lineup.originalChip;
  busy(button, true);
  try {
    await api.saveLineup(session.entry, lineupPayload(lineup.picks, lineup.chip));
    await app.reload();
    const stillActive = cancellingChip && app.team.activeChip === lineup.originalChip;
    toast(stillActive ? 'Team saved, but FPL kept your chip active. Cancel it on the FPL website if you need to.' : 'Team saved.', stillActive ? 'info' : 'success', 6000);
  } catch (err) {
    toast(err.message, 'error', 8000);
    busy(button, false);
  }
}

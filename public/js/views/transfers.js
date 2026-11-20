// Transfers: pick players to sell, browse replacements, see the budget and the
// points cost, play Wildcard or Free Hit, then confirm with FPL.

import * as api from '../api.js';
import { chipsFor, upcoming } from '../data.js';
import {
  POSITIONS, PLAYER_TYPES, addTransfer, removeTransfer, transferSummary, checkReplacement, transfersPayload, sameLineup,
} from '../rules.js';
import { esc, money, deadlineText, toast, busy, confirmModal, closeModal, statusFlag, fdrClass, posShort } from '../ui.js';
import { playerCard, openPlayer } from './player.js';

const SORTS = {
  total_points: 'Total points',
  form: 'Form',
  now_cost: 'Price',
  selected_by_percent: 'Selected by %',
  ep_next: 'Expected points (next)',
  event_points: 'Last gameweek points',
  transfers_in_event: 'Transfers in (this GW)',
};
const TRANSFER_CHIPS = { wildcard: 'Wildcard', freehit: 'Free Hit' };
const MAX_ROWS = 80;

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function context(app) {
  const { d, team, transfer } = app;
  const activeTransferChip = TRANSFER_CHIPS[team.activeChip] ? team.activeChip : null;
  const chip = transfer.chip ?? activeTransferChip;
  const limit = team.editable ? team.transfers.limit : (transfer.free ?? 1);
  const made = team.editable ? team.transfers.made : 0;
  const summary = transferSummary({
    picks: team.picks,
    pending: transfer.pending,
    bank: team.bank,
    limit,
    made,
    cost: team.transfers.cost,
    chip,
    teamOf: d.teamOf,
    typeOf: d.typeOf,
    rules: d.rules,
  });
  const outPick = transfer.outId != null ? summary.squad.find((p) => p.element === transfer.outId) ?? null : null;
  return { summary, chip, activeTransferChip, outPick, limit, made };
}

function sellPrice(p) {
  return p.selling_price ?? p.purchase_price ?? 0;
}

export function render(root, app) {
  const { d, team, transfer } = app;
  const next = d.next;
  if (!next) {
    root.innerHTML = '<div class="empty-state"><h2>The season is over</h2><p>There are no more gameweeks to make transfers for.</p></div>';
    return;
  }
  const ctx = context(app);
  const { summary, chip, activeTransferChip, outPick } = ctx;
  const chips = chipsFor(team, next.id);
  const teamChipPlanned = app.lineup.chip || ['bboost', '3xc'].includes(team.activeChip);

  const squadRows = [1, 2, 3, 4].map((type) => {
    const cards = summary.squad
      .filter((p) => d.typeOf(p.element) === type)
      .sort((a, b) => a.position - b.position)
      .map((p) => {
        const classes = [p.element === transfer.outId ? 'is-out' : '', p.incoming ? 'is-in' : ''].join(' ');
        return playerCard(app, p.element, { label: money(sellPrice(p)), labelClass: 'price-tag', classes, tag: p.incoming ? '<span class="in-tag">IN</span>' : '' });
      }).join('');
    return `<div class="pitch-row">${cards}</div>`;
  }).join('');

  const freeText = Number.isFinite(summary.freeLeft) ? String(summary.freeLeft) : 'Unlimited';
  const chipButtons = Object.entries(TRANSFER_CHIPS).map(([name, label]) => {
    const c = chips.get(name);
    if (team.editable && !c) return '';
    const on = chip === name;
    const status = c?.status_for_entry;
    const alreadyActive = activeTransferChip === name;
    let state = on ? 'Active' : 'Play';
    let disabled = false;
    let title = name === 'wildcard' ? 'Unlimited free transfers this gameweek. Changes are permanent.' : 'Unlimited free transfers for one gameweek. Your squad goes back to how it was afterwards.';
    if (team.editable) {
      if (status === 'played') { state = `Played${c.played_by_entry?.length ? ` GW${c.played_by_entry.at(-1)}` : ''}`; disabled = true; }
      else if (status !== 'available' && !alreadyActive) { state = 'Unavailable'; disabled = true; }
      if (alreadyActive) disabled = true;
      if (!on && (activeTransferChip || teamChipPlanned)) { disabled = true; title = 'You can only play one chip per gameweek.'; }
    } else {
      title = `Planning only: assume you play ${label}.`;
      if (!on && chip) disabled = true;
    }
    return `<button class="chip-btn ${on ? 'is-on' : ''}" data-chip="${name}" ${disabled ? 'disabled' : ''} title="${esc(title)}"><span>${esc(label)}</span><small>${esc(state)}</small></button>`;
  }).join('');

  const pendingList = transfer.pending.map((t) => {
    const out = d.elements.get(t.element_out);
    const inn = d.elements.get(t.element_in);
    return `<li>
        <span class="t-out"><small>OUT</small>${esc(out?.web_name)} <span class="muted">${esc(money(t.selling_price))}</span></span>
        <span class="t-arrow" aria-hidden="true">→</span>
        <span class="t-in"><small>IN</small>${esc(inn?.web_name)} <span class="muted">${esc(money(t.purchase_price))}</span></span>
        <button class="btn btn-small" data-undo="${t.element_in}">Undo</button>
      </li>`;
  }).join('');

  const f = transfer.filters;
  const teamOptions = [...d.teams.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `<option value="${t.id}" ${f.team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const prices = [];
  for (let p = 150; p >= 40; p -= 5) prices.push(p);

  root.innerHTML = `
    <section class="view view-transfers">
      <div class="view-head">
        <div>
          <h1>Transfers</h1>
          <p class="muted">${esc(next.name)} · Deadline ${esc(deadlineText(next.deadline_time))}</p>
        </div>
        ${chipButtons ? `<div class="chip-bar">${chipButtons}</div>` : ''}
      </div>
      ${!team.editable ? `<p class="note">View only: planning from your Gameweek ${esc(team.viewEvent)} squad, using today's prices as selling prices. Log in to make the transfers for real.</p>` : ''}
      <div class="stat-strip">
        <div><span>Free transfers</span>${team.editable || chip ? `<strong>${esc(freeText)}</strong>` : `<select data-free aria-label="Free transfers available">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${(transfer.free ?? 1) === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`}</div>
        <div><span>Points cost</span><strong class="${summary.pointsCost ? 'text-bad' : ''}">${summary.pointsCost ? `-${summary.pointsCost} pts` : '0 pts'}</strong></div>
        <div><span>Money in bank</span><strong class="${summary.bankAfter < 0 ? 'text-bad' : ''}">${esc(money(summary.bankAfter))}</strong></div>
        <div><span>Planned</span><strong>${transfer.pending.length}</strong></div>
      </div>

      <div class="transfer-grid">
        <div class="squad-panel">
          <p class="hint">${outPick ? `Choose a replacement for <strong>${esc(d.elements.get(outPick.element)?.web_name)}</strong>, or tap them again to cancel.` : 'Tap a player to sell them.'}</p>
          <div class="pitch pitch-compact">
            <div class="pitch-lines" aria-hidden="true"></div>
            ${squadRows}
          </div>
          ${transfer.pending.length ? `<ul class="pending">${pendingList}</ul>` : ''}
          <div class="action-bar">
            <div class="action-msg">${summary.errors.length ? `<span class="text-bad">${esc(summary.errors[0])}</span>` : transfer.pending.length ? `<span>${transfer.pending.length} transfer${transfer.pending.length > 1 ? 's' : ''} planned${summary.pointsCost ? `, costing ${summary.pointsCost} points` : ''}.</span>` : '<span class="muted">No transfers planned.</span>'}</div>
            <div class="row-gap">
              <button class="btn" data-action="reset" ${transfer.pending.length || transfer.chip || transfer.outId != null ? '' : 'disabled'}>Reset</button>
              <button class="btn btn-primary" data-action="confirm" ${transfer.pending.length && summary.ok && team.editable ? '' : 'disabled'} ${team.editable ? '' : 'title="Log in to make transfers"'}>Make transfers</button>
            </div>
          </div>
        </div>

        <div class="market-panel" id="market">
          <div class="market-head" data-market-head></div>
          <form class="filters" data-filters>
            <input type="search" name="q" value="${esc(f.q)}" placeholder="Search players" aria-label="Search players" autocomplete="off">
            <select name="type" aria-label="Position">
              <option value="0">All positions</option>
              ${[1, 2, 3, 4].map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${esc(POSITIONS[t].plural.replace(/^./, (c) => c.toUpperCase()))}</option>`).join('')}
            </select>
            <select name="team" aria-label="Club"><option value="0">All clubs</option>${teamOptions}</select>
            <select name="maxPrice" aria-label="Maximum price">
              <option value="">Any price</option>
              ${prices.map((p) => `<option value="${p}" ${Number(f.maxPrice) === p ? 'selected' : ''}>Up to ${money(p)}</option>`).join('')}
            </select>
            <select name="sort" aria-label="Sort by">
              ${Object.entries(SORTS).map(([k, label]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>Sort: ${esc(label)}</option>`).join('')}
            </select>
            <label class="check"><input type="checkbox" name="available" ${f.available ? 'checked' : ''}> Fit players only</label>
          </form>
          <ul class="market-list" data-market-list></ul>
        </div>
      </div>
    </section>`;

  renderMarket(root, app, ctx);

  root.onsubmit = (e) => e.preventDefault();

  root.oninput = (e) => {
    const form = e.target.closest('[data-filters]');
    if (form) {
      f.q = form.q.value;
      f.type = Number(form.type.value);
      f.team = Number(form.team.value);
      f.maxPrice = form.maxPrice.value;
      f.sort = form.sort.value;
      f.available = form.available.checked;
      renderMarket(root, app, context(app));
      return;
    }
    if (e.target.matches('[data-free]')) {
      transfer.free = Number(e.target.value);
      app.render();
    }
  };

  root.onclick = async (e) => {
    const card = e.target.closest('.pcard');
    if (card) {
      const id = Number(card.dataset.id);
      if (transfer.outId === id) {
        transfer.outId = null;
      } else {
        transfer.outId = id;
        transfer.filters.type = d.typeOf(id);
      }
      app.render();
      if (transfer.outId != null && window.matchMedia('(max-width: 900px)').matches) {
        document.getElementById('market')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const pickBtn = e.target.closest('[data-pick]');
    if (pickBtn) { choose(app, Number(pickBtn.dataset.pick)); return; }
    const infoBtn = e.target.closest('[data-info]');
    if (infoBtn) { showCandidate(app, Number(infoBtn.dataset.info)); return; }
    const undo = e.target.closest('[data-undo]');
    if (undo) {
      transfer.pending = removeTransfer(transfer.pending, Number(undo.dataset.undo));
      app.render();
      return;
    }
    const chipBtn = e.target.closest('[data-chip]');
    if (chipBtn) { await toggleChip(app, chipBtn.dataset.chip); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'clear-out') { transfer.outId = null; app.render(); return; }
    if (action === 'reset') {
      transfer.pending = [];
      transfer.outId = null;
      transfer.chip = null;
      app.render();
      return;
    }
    if (action === 'confirm') await confirmTransfers(app, e.target.closest('button'));
  };
}

function marketPlayers(app) {
  const { d, transfer } = app;
  const f = transfer.filters;
  const q = fold(f.q.trim());
  const max = f.maxPrice ? Number(f.maxPrice) : null;
  const list = d.bootstrap.elements.filter((e) =>
    PLAYER_TYPES.includes(e.element_type) && !e.removed
    && (!f.type || e.element_type === f.type)
    && (!f.team || e.team === f.team)
    && (max == null || e.now_cost <= max)
    && (!f.available || e.status === 'a')
    && (!q || fold(`${e.web_name} ${e.first_name} ${e.second_name} ${d.teams.get(e.team)?.name ?? ''}`).includes(q)));
  const key = f.sort;
  list.sort((a, b) => Number(b[key]) - Number(a[key]) || b.total_points - a.total_points);
  return list;
}

function statValue(el, sort) {
  if (sort === 'now_cost') return el.total_points;
  if (sort === 'selected_by_percent') return `${el.selected_by_percent}%`;
  return el[sort];
}

function renderMarket(root, app, ctx) {
  const { d, transfer } = app;
  const { summary, outPick } = ctx;
  const list = marketPlayers(app);
  const head = root.querySelector('[data-market-head]');
  const box = root.querySelector('[data-market-list]');
  const sort = transfer.filters.sort;
  const statLabel = sort === 'now_cost' ? 'Pts' : { total_points: 'Pts', form: 'Form', selected_by_percent: 'Sel', ep_next: 'xP', event_points: 'GW', transfers_in_event: 'In' }[sort];

  if (outPick) {
    const el = d.elements.get(outPick.element);
    const budget = summary.bankAfter + sellPrice(outPick);
    head.innerHTML = `<div><strong>Replacing ${esc(el.web_name)}</strong><span class="muted"> · ${esc(posShort(el.element_type))} · sells for ${esc(money(sellPrice(outPick)))} · you can spend up to <strong>${esc(money(Math.max(0, budget)))}</strong></span></div>
      <button class="btn btn-small" data-action="clear-out">Cancel</button>`;
  } else {
    head.innerHTML = `<div><strong>Player list</strong><span class="muted"> · ${list.length} players</span></div>`;
  }

  const rows = list.slice(0, MAX_ROWS).map((el) => {
    const team = d.teams.get(el.team);
    const check = outPick ? checkReplacement({ candidate: el, outPick, summary, typeOf: d.typeOf, teamOf: d.teamOf, rules: d.rules }) : null;
    const inSquad = summary.squad.some((p) => p.element === el.id);
    const blocked = check && !check.ok;
    const fx = upcoming(d, el.team, 3).map(({ fixtures }) => `<span class="mini-fx ${fdrClass(fixtures)}" title="${esc(fixtures.map((x) => `${d.teams.get(x.opp)?.name} (${x.home ? 'H' : 'A'})`).join(', ') || 'No game')}">${fixtures.length ? esc(fixtures.map((x) => d.teams.get(x.opp)?.short_name).join('+')) : '–'}</span>`).join('');
    return `<li class="mrow ${blocked ? 'is-blocked' : ''} ${inSquad ? 'is-owned' : ''}">
        <button type="button" class="mrow-main" data-pick="${el.id}" aria-label="${esc(`${el.web_name}, ${team?.short_name} ${posShort(el.element_type)}, ${money(el.now_cost)}${blocked ? `, ${check.reason}` : ''}`)}">
          <span class="mrow-name"><strong>${statusFlag(el)}${esc(el.web_name)}</strong><small>${esc(team?.short_name ?? '')} · ${esc(posShort(el.element_type))}${inSquad ? ' · in squad' : ''}${blocked && !inSquad ? ` · <span class="text-bad">${esc(check.reason)}</span>` : ''}</small></span>
          <span class="mrow-fx">${fx}</span>
          <span class="mrow-num">${esc(money(el.now_cost))}</span>
          <span class="mrow-num mrow-stat" title="${esc(SORTS[sort])}">${esc(statValue(el, sort))}<small>${esc(statLabel)}</small></span>
        </button>
        <button type="button" class="icon-btn" data-info="${el.id}" aria-label="${esc(el.web_name)} details">i</button>
      </li>`;
  }).join('');
  box.innerHTML = rows || '<li class="empty">No players match those filters.</li>';
  if (list.length > MAX_ROWS) box.insertAdjacentHTML('beforeend', `<li class="empty small">Showing the top ${MAX_ROWS} of ${list.length}. Narrow the filters to see more.</li>`);
}

function choose(app, candidateId) {
  const { d } = app;
  const ctx = context(app);
  if (!ctx.outPick) { showCandidate(app, candidateId); return; }
  const candidate = d.elements.get(candidateId);
  const check = checkReplacement({ candidate, outPick: ctx.outPick, summary: ctx.summary, typeOf: d.typeOf, teamOf: d.teamOf, rules: d.rules });
  if (!check.ok) { toast(check.reason, 'error'); return; }
  bringIn(app, ctx.outPick, candidate);
}

function bringIn(app, outPick, candidate) {
  const { d, transfer } = app;
  const outName = d.elements.get(outPick.element)?.web_name;
  transfer.pending = addTransfer(transfer.pending, {
    outId: outPick.element,
    inId: candidate.id,
    sellingPrice: sellPrice(outPick),
    purchasePrice: candidate.now_cost,
  });
  transfer.outId = null;
  closeModal();
  app.render();
  toast(`${candidate.web_name} in, ${outName} out.`, 'success', 2500);
}

// Details for a player on the list, with buttons to bring them in for each
// squad player in the same position.
function showCandidate(app, id) {
  const { d } = app;
  const ctx = context(app);
  const candidate = d.elements.get(id);
  const inSquad = ctx.summary.squad.some((p) => p.element === id);
  const options = inSquad ? [] : (ctx.outPick ? [ctx.outPick] : ctx.summary.squad.filter((p) => d.typeOf(p.element) === candidate.element_type));
  const actions = options.map((p) => {
    const check = checkReplacement({ candidate, outPick: p, summary: ctx.summary, typeOf: d.typeOf, teamOf: d.teamOf, rules: d.rules });
    const name = d.elements.get(p.element)?.web_name;
    return {
      name: `swap-${p.element}`,
      label: `Replace ${name}`,
      kind: check.ok ? 'primary' : '',
      disabled: !check.ok,
      hint: check.ok ? `Sell ${name} for ${money(sellPrice(p))}` : check.reason,
      handler: () => bringIn(app, p, candidate),
    };
  });
  const note = inSquad ? 'Already in your squad.' : options.length ? (ctx.outPick ? '' : 'Bring this player in by replacing:') : '';
  openPlayer(app, id, { actions, note: esc(note) });
}

async function toggleChip(app, name) {
  const { transfer } = app;
  if (transfer.chip === name) {
    transfer.chip = null;
    app.render();
    return;
  }
  if (app.team.editable) {
    const ok = await confirmModal({
      title: `Play ${TRANSFER_CHIPS[name]}?`,
      body: name === 'wildcard'
        ? '<p>All transfers this gameweek are free and permanent.</p><p class="muted">The chip is played when you confirm your transfers. You only have one Wildcard for this half of the season.</p>'
        : '<p>All transfers this gameweek are free, and your squad goes back to how it was for the gameweek after.</p><p class="muted">The chip is played when you confirm your transfers.</p>',
      confirmLabel: `Use ${TRANSFER_CHIPS[name]}`,
    });
    if (!ok) return;
  }
  transfer.chip = name;
  app.render();
}

async function confirmTransfers(app, button) {
  const { d, transfer, session, lineup } = app;
  const ctx = context(app);
  if (!ctx.summary.ok) { toast(ctx.summary.errors[0], 'error'); return; }
  const rows = transfer.pending.map((t) => `<tr><td>${esc(d.elements.get(t.element_out)?.web_name)} <span class="muted">${esc(money(t.selling_price))}</span></td><td aria-hidden="true">→</td><td><strong>${esc(d.elements.get(t.element_in)?.web_name)}</strong> <span class="muted">${esc(money(t.purchase_price))}</span></td></tr>`).join('');
  const lineupDirty = !sameLineup(lineup.picks, lineup.original) || lineup.chip !== lineup.originalChip;
  const ok = await confirmModal({
    title: 'Confirm transfers',
    body: `<table class="confirm-table">${rows}</table>
      <div class="stat-strip stat-strip-small">
        <div><span>Points cost</span><strong class="${ctx.summary.pointsCost ? 'text-bad' : ''}">${ctx.summary.pointsCost ? `-${ctx.summary.pointsCost} pts` : 'Free'}</strong></div>
        <div><span>Bank after</span><strong>${esc(money(ctx.summary.bankAfter))}</strong></div>
        ${transfer.chip ? `<div><span>Chip</span><strong>${esc(TRANSFER_CHIPS[transfer.chip])}</strong></div>` : ''}
      </div>
      <p class="muted small">Transfers can't be undone once FPL accepts them. ${lineupDirty ? 'Your unsaved Pick Team changes will be cleared, so save them first if you want to keep them.' : ''}</p>`,
    confirmLabel: transfer.pending.length > 1 ? `Make ${transfer.pending.length} transfers` : 'Make transfer',
  });
  if (!ok) return;
  busy(button, true);
  try {
    await api.makeTransfers(transfersPayload({ entry: session.entry, event: d.next.id, pending: transfer.pending, chip: transfer.chip }));
    const count = transfer.pending.length;
    await app.reload();
    toast(`${count} transfer${count > 1 ? 's' : ''} made.`, 'success');
  } catch (err) {
    toast(err.message, 'error', 9000);
    busy(button, false);
  }
}

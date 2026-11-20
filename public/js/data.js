// Loads FPL data and builds the lookups the views need.

import * as api from './api.js';
import { rulesFromBootstrap } from './rules.js';

export function indexData(bootstrap, fixtures) {
  const elements = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const teams = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const events = bootstrap.events ?? [];
  const fixturesByTeam = new Map();
  const add = (team, item) => {
    if (!fixturesByTeam.has(team)) fixturesByTeam.set(team, new Map());
    const byEvent = fixturesByTeam.get(team);
    if (!byEvent.has(item.event)) byEvent.set(item.event, []);
    byEvent.get(item.event).push(item);
  };
  for (const f of fixtures) {
    if (!f.event) continue; // unscheduled
    add(f.team_h, { opp: f.team_a, home: true, difficulty: f.team_h_difficulty, event: f.event, kickoff: f.kickoff_time, finished: f.finished });
    add(f.team_a, { opp: f.team_h, home: false, difficulty: f.team_a_difficulty, event: f.event, kickoff: f.kickoff_time, finished: f.finished });
  }
  for (const byEvent of fixturesByTeam.values()) {
    for (const list of byEvent.values()) list.sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  }
  return {
    bootstrap,
    elements,
    teams,
    events,
    fixtures,
    fixturesByTeam,
    next: events.find((e) => e.is_next) ?? null,
    current: events.find((e) => e.is_current) ?? null,
    rules: rulesFromBootstrap(bootstrap),
    typeOf: (id) => elements.get(id)?.element_type,
    teamOf: (id) => elements.get(id)?.team,
  };
}

export const fixturesFor = (d, teamId, event) => d.fixturesByTeam.get(teamId)?.get(event) ?? [];

export function upcoming(d, teamId, count, from = d.next?.id ?? 1) {
  const out = [];
  for (let gw = from; gw < from + count && gw <= d.events.length; gw++) out.push({ event: gw, fixtures: fixturesFor(d, teamId, gw) });
  return out;
}

export async function loadGameData() {
  const [bootstrap, fixtures] = await Promise.all([api.fpl('bootstrap-static/'), api.fpl('fixtures/')]);
  return indexData(bootstrap, fixtures);
}

// The manager's squad in one shape, whether it came from the logged-in
// my-team endpoint or the public picks endpoint.
export async function loadTeam(session, d) {
  const entryId = session.entry;
  const entry = await api.fpl(`entry/${entryId}/`).catch(() => null);
  if (session.mode === 'auth') {
    const mt = await api.fpl(`my-team/${entryId}/`);
    const chips = mt.chips ?? [];
    return {
      editable: true,
      entry,
      picks: (mt.picks ?? []).map(toPick),
      chips,
      transfers: { limit: mt.transfers?.limit ?? null, made: mt.transfers?.made ?? 0, cost: mt.transfers?.cost ?? 4, status: mt.transfers?.status ?? null },
      bank: mt.transfers?.bank ?? entry?.last_deadline_bank ?? 0,
      value: mt.transfers?.value ?? null,
      activeChip: chips.find((c) => c.status_for_entry === 'active' && c.is_pending !== false)?.name ?? null,
    };
  }
  const gw = entry?.current_event ?? d.current?.id;
  if (!gw) throw new Error("This team hasn't played a gameweek yet, so there is no squad to show without logging in.");
  const res = await api.fpl(`entry/${entryId}/event/${gw}/picks/`);
  return {
    editable: false,
    entry,
    viewEvent: gw,
    picks: (res.picks ?? []).map((p) => ({ ...toPick(p), selling_price: d.elements.get(p.element)?.now_cost ?? 0, purchase_price: null })),
    chips: [],
    transfers: { limit: 1, made: 0, cost: 4, status: null, assumed: true },
    bank: res.entry_history?.bank ?? entry?.last_deadline_bank ?? 0,
    value: res.entry_history?.value ?? null,
    activeChip: null,
  };
}

function toPick(p) {
  return {
    element: p.element,
    position: p.position,
    is_captain: Boolean(p.is_captain),
    is_vice_captain: Boolean(p.is_vice_captain),
    multiplier: p.multiplier,
    selling_price: p.selling_price ?? null,
    purchase_price: p.purchase_price ?? null,
  };
}

// Chips usable in `event`: the copy of each chip whose window covers it.
export function chipsFor(team, event) {
  const LABELS = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain', manager: 'Assistant Manager' };
  const byName = new Map();
  for (const c of team.chips ?? []) {
    const inWindow = (c.start_event ?? 1) <= event && event <= (c.stop_event ?? 38);
    if (!inWindow) continue;
    const rank = { active: 3, available: 2 }[c.status_for_entry] ?? 1;
    const prev = byName.get(c.name);
    if (prev && prev.rank >= rank) continue;
    byName.set(c.name, { ...c, rank, label: LABELS[c.name] ?? c.name });
  }
  return byName;
}

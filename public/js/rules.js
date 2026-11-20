// Pure FPL game rules: line-up validity, substitutions, captaincy and transfer
// planning. No DOM or network code lives here, so it runs in the browser and in
// Node's test runner alike.

export const POSITIONS = {
  1: { short: 'GKP', name: 'Goalkeeper', plural: 'goalkeepers' },
  2: { short: 'DEF', name: 'Defender', plural: 'defenders' },
  3: { short: 'MID', name: 'Midfielder', plural: 'midfielders' },
  4: { short: 'FWD', name: 'Forward', plural: 'forwards' },
};

export const OUTFIELD_TYPES = [2, 3, 4];
export const PLAYER_TYPES = [1, 2, 3, 4];

export const DEFAULT_RULES = Object.freeze({
  squad: { 1: 2, 2: 5, 3: 5, 4: 3 },
  xiMin: { 1: 1, 2: 3, 3: 2, 4: 1 },
  xiMax: { 1: 1, 2: 5, 3: 5, 4: 3 },
  maxPerClub: 3,
  squadSize: 15,
  xiSize: 11,
  hitCost: 4,
});

// Reads squad limits from bootstrap-static so the app follows any rule change
// FPL makes, falling back to the long-standing defaults.
export function rulesFromBootstrap(bootstrap) {
  const rules = {
    squad: { ...DEFAULT_RULES.squad },
    xiMin: { ...DEFAULT_RULES.xiMin },
    xiMax: { ...DEFAULT_RULES.xiMax },
    maxPerClub: DEFAULT_RULES.maxPerClub,
    squadSize: DEFAULT_RULES.squadSize,
    xiSize: DEFAULT_RULES.xiSize,
    hitCost: DEFAULT_RULES.hitCost,
  };
  for (const t of bootstrap?.element_types ?? []) {
    if (!PLAYER_TYPES.includes(t.id)) continue;
    if (Number.isInteger(t.squad_select) && t.squad_select > 0) rules.squad[t.id] = t.squad_select;
    if (Number.isInteger(t.squad_min_play)) rules.xiMin[t.id] = t.squad_min_play;
    if (Number.isInteger(t.squad_max_play) && t.squad_max_play > 0) rules.xiMax[t.id] = t.squad_max_play;
  }
  const gs = bootstrap?.game_settings ?? {};
  if (Number.isInteger(gs.squad_team_limit) && gs.squad_team_limit > 0) rules.maxPerClub = gs.squad_team_limit;
  if (Number.isInteger(gs.squad_squadsize) && gs.squad_squadsize > 0) rules.squadSize = gs.squad_squadsize;
  if (Number.isInteger(gs.squad_squadplay) && gs.squad_squadplay > 0) rules.xiSize = gs.squad_squadplay;
  return rules;
}

const plural = (type, n) => (n === 1 ? POSITIONS[type].name.toLowerCase() : POSITIONS[type].plural);

export function countTypes(ids, typeOf) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const id of ids) counts[typeOf(id)] = (counts[typeOf(id)] ?? 0) + 1;
  return counts;
}

export const starterPicks = (picks) => picks.filter((p) => p.position <= 11).sort((a, b) => a.position - b.position);
export const benchPicks = (picks) => picks.filter((p) => p.position > 11).sort((a, b) => a.position - b.position);

export function formation(picks, typeOf) {
  const c = countTypes(starterPicks(picks).map((p) => p.element), typeOf);
  return `${c[2]}-${c[3]}-${c[4]}`;
}

export function validateXI(starterIds, typeOf, rules = DEFAULT_RULES) {
  if (starterIds.length !== rules.xiSize) {
    return { ok: false, reason: `Your starting line-up needs ${rules.xiSize} players.` };
  }
  const c = countTypes(starterIds, typeOf);
  for (const t of PLAYER_TYPES) {
    if (c[t] < rules.xiMin[t]) {
      return { ok: false, reason: `You need at least ${rules.xiMin[t]} ${plural(t, rules.xiMin[t])} in your starting line-up.` };
    }
    if (c[t] > rules.xiMax[t]) {
      return { ok: false, reason: `You can't start more than ${rules.xiMax[t]} ${plural(t, rules.xiMax[t])}.` };
    }
  }
  return { ok: true };
}

// Starters are ordered by position type (GK, DEF, MID, FWD) like the official
// game; the bench keeps the goalkeeper in slot 12 and the outfield order the
// manager chose in 13-15.
export function normalizePositions(picks, typeOf) {
  const next = picks.map((p) => ({ ...p }));
  const starters = next
    .filter((p) => p.position <= 11)
    .sort((a, b) => typeOf(a.element) - typeOf(b.element) || a.position - b.position);
  starters.forEach((p, i) => { p.position = i + 1; });
  const isGk = (p) => (typeOf(p.element) === 1 ? 0 : 1);
  const bench = next
    .filter((p) => p.position > 11)
    .sort((a, b) => isGk(a) - isGk(b) || a.position - b.position);
  bench.forEach((p, i) => { p.position = starters.length + 1 + i; });
  return [...starters, ...bench];
}

export function canSwap(picks, aId, bId, typeOf, rules = DEFAULT_RULES) {
  if (aId === bId) return false;
  const a = picks.find((p) => p.element === aId);
  const b = picks.find((p) => p.element === bId);
  if (!a || !b) return false;
  const aStarts = a.position <= 11;
  const bStarts = b.position <= 11;
  if (aStarts && bStarts) return false;
  const aGk = typeOf(aId) === 1;
  const bGk = typeOf(bId) === 1;
  if (!aStarts && !bStarts) return !aGk && !bGk; // reorder outfield bench
  if (aGk !== bGk) return false;
  const [starter, sub] = aStarts ? [a, b] : [b, a];
  const xi = starterPicks(picks).map((p) => (p.element === starter.element ? sub.element : p.element));
  return validateXI(xi, typeOf, rules).ok;
}

export function swapPlayers(picks, aId, bId, typeOf) {
  const next = picks.map((p) => ({ ...p }));
  const a = next.find((p) => p.element === aId);
  const b = next.find((p) => p.element === bId);
  const aStarts = a.position <= 11;
  const bStarts = b.position <= 11;
  [a.position, b.position] = [b.position, a.position];
  if (aStarts !== bStarts) {
    // The armband moves with the slot, as it does on the official site.
    const [out, incoming] = aStarts ? [a, b] : [b, a];
    if (out.is_captain) { out.is_captain = false; incoming.is_captain = true; }
    if (out.is_vice_captain) { out.is_vice_captain = false; incoming.is_vice_captain = true; }
  }
  return normalizePositions(next, typeOf);
}

export function setCaptain(picks, id) {
  const target = picks.find((p) => p.element === id);
  if (!target || target.position > 11) return picks;
  const wasVice = target.is_vice_captain;
  const oldCaptain = picks.find((p) => p.is_captain);
  return picks.map((p) => {
    if (p.element === id) return { ...p, is_captain: true, is_vice_captain: false };
    if (p === oldCaptain) return { ...p, is_captain: false, is_vice_captain: wasVice };
    return p;
  });
}

export function setViceCaptain(picks, id) {
  const target = picks.find((p) => p.element === id);
  if (!target || target.position > 11) return picks;
  const wasCaptain = target.is_captain;
  const oldVice = picks.find((p) => p.is_vice_captain);
  return picks.map((p) => {
    if (p.element === id) return { ...p, is_vice_captain: true, is_captain: false };
    if (p === oldVice) return { ...p, is_vice_captain: false, is_captain: wasCaptain };
    return p;
  });
}

export function lineupProblems(picks, typeOf, rules = DEFAULT_RULES) {
  const problems = [];
  if (picks.length !== rules.squadSize) problems.push(`Your squad needs ${rules.squadSize} players.`);
  const xi = validateXI(starterPicks(picks).map((p) => p.element), typeOf, rules);
  if (!xi.ok) problems.push(xi.reason);
  const captains = picks.filter((p) => p.is_captain);
  const vices = picks.filter((p) => p.is_vice_captain);
  if (captains.length !== 1 || captains[0].position > 11) problems.push('Pick a captain from your starting line-up.');
  if (vices.length !== 1 || vices[0].position > 11) problems.push('Pick a vice-captain from your starting line-up.');
  if (captains[0] && vices[0] && captains[0].element === vices[0].element) {
    problems.push('Your captain and vice-captain must be different players.');
  }
  return problems;
}

export function lineupPayload(picks, chip = null) {
  return {
    chip: chip ?? null,
    picks: [...picks]
      .sort((a, b) => a.position - b.position)
      .map(({ element, position, is_captain, is_vice_captain }) => ({
        element,
        position,
        is_captain: Boolean(is_captain),
        is_vice_captain: Boolean(is_vice_captain),
      })),
  };
}

export function sameLineup(a, b) {
  const key = (picks) => lineupPayload(picks).picks.map((p) => `${p.element}:${p.position}:${+p.is_captain}${+p.is_vice_captain}`).join(',');
  return key(a) === key(b);
}

// ---------------------------------------------------------------- transfers

// pending: [{ element_out, element_in, selling_price, purchase_price }]
// Chaining (A out for B, then B out for C) collapses into A -> C, and bringing
// the original player back cancels the transfer.
export function addTransfer(pending, { outId, inId, sellingPrice, purchasePrice }) {
  const list = pending.map((t) => ({ ...t }));
  const chained = list.find((t) => t.element_in === outId);
  if (chained) {
    if (chained.element_out === inId) return list.filter((t) => t !== chained);
    chained.element_in = inId;
    chained.purchase_price = purchasePrice;
    return list;
  }
  list.push({ element_out: outId, element_in: inId, selling_price: sellingPrice, purchase_price: purchasePrice });
  return list;
}

export function removeTransfer(pending, inId) {
  return pending.filter((t) => t.element_in !== inId);
}

// The squad as it would look after the pending transfers. Incoming players take
// the outgoing player's slot and are valued at their purchase price.
export function plannedSquad(picks, pending) {
  const byOut = new Map(pending.map((t) => [t.element_out, t]));
  return picks.map((p) => {
    const t = byOut.get(p.element);
    if (!t) return { ...p, incoming: false };
    return {
      ...p,
      element: t.element_in,
      selling_price: t.purchase_price,
      purchase_price: t.purchase_price,
      replaces: t.element_out,
      incoming: true,
    };
  });
}

export function isUnlimited(limit, chip) {
  return limit === null || limit === undefined || chip === 'wildcard' || chip === 'freehit';
}

export function transferSummary({ picks, pending, bank, limit, made = 0, cost = DEFAULT_RULES.hitCost, chip = null, teamOf, typeOf, rules = DEFAULT_RULES }) {
  const squad = plannedSquad(picks, pending);
  const bankAfter = pending.reduce((sum, t) => sum + t.selling_price - t.purchase_price, bank);
  const clubCounts = new Map();
  for (const p of squad) clubCounts.set(teamOf(p.element), (clubCounts.get(teamOf(p.element)) ?? 0) + 1);
  const unlimited = isUnlimited(limit, chip);
  const freeLeft = unlimited ? Infinity : Math.max(0, limit - made);
  const hits = unlimited ? 0 : Math.max(0, pending.length - freeLeft);
  const pointsCost = hits * (cost ?? DEFAULT_RULES.hitCost);

  const errors = [];
  if (bankAfter < 0) errors.push(`You're £${(-bankAfter / 10).toFixed(1)}m over budget.`);
  const overClubs = [...clubCounts].filter(([, n]) => n > rules.maxPerClub).map(([team]) => team);
  if (overClubs.length) errors.push(`You can have at most ${rules.maxPerClub} players from one club.`);
  const ids = squad.map((p) => p.element);
  if (new Set(ids).size !== ids.length) errors.push('A player appears in your squad twice.');
  for (const t of pending) {
    if (typeOf(t.element_in) !== typeOf(t.element_out)) errors.push('Players must be replaced by a player in the same position.');
  }
  return { squad, bankAfter, clubCounts, overClubs, freeLeft, hits, pointsCost, errors, ok: errors.length === 0 };
}

// Can `candidate` (a bootstrap element) replace the planned-squad pick `outPick`?
export function checkReplacement({ candidate, outPick, summary, typeOf, teamOf, rules = DEFAULT_RULES }) {
  if (candidate.element_type !== typeOf(outPick.element)) {
    return { ok: false, reason: `Choose a ${POSITIONS[typeOf(outPick.element)].name.toLowerCase()}` };
  }
  if (summary.squad.some((p) => p.element === candidate.id)) return { ok: false, reason: 'Already in your squad' };
  const budget = summary.bankAfter + outPick.selling_price;
  if (candidate.now_cost > budget) return { ok: false, reason: `Costs £${((candidate.now_cost - budget) / 10).toFixed(1)}m too much` };
  const sameClub = teamOf(outPick.element) === candidate.team ? 1 : 0;
  if ((summary.clubCounts.get(candidate.team) ?? 0) - sameClub >= rules.maxPerClub) {
    return { ok: false, reason: `Already ${rules.maxPerClub} from this club` };
  }
  return { ok: true, budget };
}

export function transfersPayload({ entry, event, pending, chip = null }) {
  return {
    chip: chip ?? null,
    entry,
    event,
    transfers: pending.map(({ element_in, element_out, purchase_price, selling_price }) => ({
      element_in,
      element_out,
      purchase_price,
      selling_price,
    })),
  };
}

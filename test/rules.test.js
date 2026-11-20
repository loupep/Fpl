import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateXI, canSwap, swapPlayers, setCaptain, setViceCaptain, lineupProblems, lineupPayload, normalizePositions,
  addTransfer, transferSummary, checkReplacement, transfersPayload, rulesFromBootstrap, formation,
} from '../public/js/rules.js';

// Squad: ids 1-2 GK, 3-7 DEF, 8-12 MID, 13-15 FWD. Clubs: id % 6 + 1.
const TYPE = (id) => (id <= 2 ? 1 : id <= 7 ? 2 : id <= 12 ? 3 : 4);
const CLUB = (id) => (id % 6) + 1;

// 4-4-2 with bench GK 2, then MID 12, DEF 7, FWD 15.
function squad() {
  const order = [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 2, 12, 7, 15];
  return order.map((element, i) => ({
    element,
    position: i + 1,
    is_captain: element === 13,
    is_vice_captain: element === 8,
    selling_price: 50,
    purchase_price: 50,
  }));
}
const pos = (picks, id) => picks.find((p) => p.element === id).position;

test('validateXI accepts legal formations and rejects illegal ones', () => {
  assert.equal(validateXI([1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14], TYPE).ok, true); // 4-4-2
  assert.equal(validateXI([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13], TYPE).ok, true); // 5-4-1
  assert.equal(validateXI([1, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15], TYPE).ok, false); // only 2 DEF
  assert.match(validateXI([1, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15], TYPE).reason, /at least 3 defenders/);
  assert.equal(validateXI([1, 2, 3, 4, 5, 8, 9, 10, 11, 13, 14], TYPE).ok, false); // two keepers
  assert.equal(validateXI([1, 3, 4, 5, 8, 9, 10, 13, 14], TYPE).ok, false); // too few players
});

test('canSwap follows the substitution rules', () => {
  const picks = squad();
  assert.equal(canSwap(picks, 1, 2, TYPE), true, 'keeper for keeper');
  assert.equal(canSwap(picks, 1, 12, TYPE), false, 'keeper for outfielder');
  assert.equal(canSwap(picks, 3, 7, TYPE), true, 'defender for defender');
  assert.equal(canSwap(picks, 13, 12, TYPE), true, 'forward for midfielder gives 4-5-1');
  assert.equal(canSwap(picks, 3, 12, TYPE), true, 'defender for midfielder gives 3-5-2');
  assert.equal(canSwap(picks, 3, 4, TYPE), false, 'two starters');
  assert.equal(canSwap(picks, 12, 7, TYPE), true, 'reorder the outfield bench');
  assert.equal(canSwap(picks, 2, 7, TYPE), false, 'bench keeper stays first');
  const threeAtBack = swapPlayers(picks, 3, 12, TYPE);
  assert.equal(canSwap(threeAtBack, 4, 15, TYPE), false, 'would leave two defenders');
});

test('swapPlayers moves players, keeps rows ordered and passes the armband on', () => {
  const picks = swapPlayers(squad(), 13, 12, TYPE); // captain 13 benched for MID 12
  assert.equal(formation(picks, TYPE), '4-5-1');
  assert.ok(pos(picks, 12) <= 11);
  assert.equal(pos(picks, 13), 13, 'benched player takes the sub slot');
  assert.equal(picks.find((p) => p.element === 12).is_captain, true);
  assert.equal(picks.find((p) => p.element === 13).is_captain, false);
  const starters = picks.filter((p) => p.position <= 11).map((p) => TYPE(p.element));
  assert.deepEqual(starters, [...starters].sort(), 'starters sorted GK, DEF, MID, FWD');
  assert.deepEqual(lineupProblems(picks, TYPE), []);
});

test('reordering the bench swaps the two slots', () => {
  const picks = swapPlayers(squad(), 12, 15, TYPE);
  assert.equal(pos(picks, 15), 13);
  assert.equal(pos(picks, 12), 15);
  assert.equal(pos(picks, 2), 12);
});

test('setCaptain and setViceCaptain swap roles cleanly', () => {
  let picks = setCaptain(squad(), 8); // the vice becomes captain
  assert.equal(picks.find((p) => p.is_captain).element, 8);
  assert.equal(picks.find((p) => p.is_vice_captain).element, 13, 'old captain becomes vice');
  picks = setViceCaptain(picks, 9);
  assert.equal(picks.find((p) => p.is_vice_captain).element, 9);
  assert.equal(picks.filter((p) => p.is_captain || p.is_vice_captain).length, 2);
  assert.deepEqual(setCaptain(picks, 12), picks, 'bench players cannot captain');
});

test('lineupPayload has 15 picks in position order with only the fields FPL needs', () => {
  const body = lineupPayload(normalizePositions(squad(), TYPE), 'bboost');
  assert.equal(body.chip, 'bboost');
  assert.equal(body.picks.length, 15);
  assert.deepEqual(Object.keys(body.picks[0]).sort(), ['element', 'is_captain', 'is_vice_captain', 'position']);
  assert.deepEqual(body.picks.map((p) => p.position), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(lineupPayload(squad()).chip, null);
});

test('addTransfer chains and cancels transfers', () => {
  let pending = addTransfer([], { outId: 3, inId: 30, sellingPrice: 50, purchasePrice: 45 });
  pending = addTransfer(pending, { outId: 30, inId: 31, sellingPrice: 45, purchasePrice: 55 });
  assert.deepEqual(pending, [{ element_out: 3, element_in: 31, selling_price: 50, purchase_price: 55 }]);
  pending = addTransfer(pending, { outId: 31, inId: 3, sellingPrice: 55, purchasePrice: 50 });
  assert.deepEqual(pending, [], 'bringing the original back cancels it');
});

test('transferSummary works out the bank, hits and club limits', () => {
  const base = { picks: squad(), bank: 10, limit: 1, made: 0, cost: 4, teamOf: (id) => (id >= 30 ? 9 : CLUB(id)), typeOf: (id) => (id >= 30 ? 2 : TYPE(id)) };
  let pending = addTransfer([], { outId: 3, inId: 30, sellingPrice: 50, purchasePrice: 55 });
  let s = transferSummary({ ...base, pending });
  assert.equal(s.bankAfter, 5);
  assert.equal(s.hits, 0);
  pending = addTransfer(pending, { outId: 4, inId: 31, sellingPrice: 50, purchasePrice: 50 });
  s = transferSummary({ ...base, pending });
  assert.equal(s.hits, 1);
  assert.equal(s.pointsCost, 4);
  assert.equal(transferSummary({ ...base, pending, chip: 'wildcard' }).pointsCost, 0);
  assert.equal(transferSummary({ ...base, pending, limit: null }).pointsCost, 0, 'unlimited');
  assert.equal(transferSummary({ ...base, pending, limit: 2, made: 1 }).pointsCost, 4, 'one free left');
  pending = addTransfer(pending, { outId: 5, inId: 32, sellingPrice: 50, purchasePrice: 60 });
  pending = addTransfer(pending, { outId: 6, inId: 33, sellingPrice: 50, purchasePrice: 40 });
  s = transferSummary({ ...base, pending });
  assert.equal(s.ok, false, 'four players from club 9');
  assert.match(s.errors.join(' '), /at most 3 players from one club/);
});

test('checkReplacement checks position, budget, ownership and clubs', () => {
  const picks = squad();
  const teamOf = (id) => (id >= 30 ? 9 : CLUB(id));
  const typeOf = (id) => (id >= 30 ? 2 : TYPE(id));
  const summary = transferSummary({ picks, pending: [], bank: 5, limit: 1, made: 0, teamOf, typeOf });
  const outPick = summary.squad.find((p) => p.element === 3); // DEF, sells for 50
  const ok = checkReplacement({ candidate: { id: 30, element_type: 2, now_cost: 55, team: 9 }, outPick, summary, typeOf, teamOf });
  assert.equal(ok.ok, true);
  assert.equal(ok.budget, 55);
  assert.match(checkReplacement({ candidate: { id: 31, element_type: 2, now_cost: 56, team: 9 }, outPick, summary, typeOf, teamOf }).reason, /£0.1m too much/);
  assert.match(checkReplacement({ candidate: { id: 32, element_type: 3, now_cost: 40, team: 9 }, outPick, summary, typeOf, teamOf }).reason, /defender/);
  assert.match(checkReplacement({ candidate: { id: 4, element_type: 2, now_cost: 40, team: CLUB(4) }, outPick, summary, typeOf, teamOf }).reason, /Already in your squad/);
  // A club that already has three players in the squad can't supply another.
  const counts = new Map();
  for (const p of picks) counts.set(CLUB(p.element), (counts.get(CLUB(p.element)) ?? 0) + 1);
  const fullClub = [...counts].find(([club, n]) => n >= 3 && club !== CLUB(3))[0];
  assert.match(checkReplacement({ candidate: { id: 40, element_type: 2, now_cost: 40, team: fullClub }, outPick, summary, typeOf, teamOf: (id) => (id === 40 ? fullClub : teamOf(id)) }).reason, /Already 3 from this club/);
});

test('transfersPayload matches the shape FPL expects', () => {
  const body = transfersPayload({ entry: 7, event: 13, chip: 'wildcard', pending: [{ element_out: 1, element_in: 2, selling_price: 50, purchase_price: 55, extra: true }] });
  assert.deepEqual(body, { chip: 'wildcard', entry: 7, event: 13, transfers: [{ element_in: 2, element_out: 1, purchase_price: 55, selling_price: 50 }] });
});

test('rulesFromBootstrap reads limits and ignores other element types', () => {
  const rules = rulesFromBootstrap({
    element_types: [
      { id: 1, squad_select: 2, squad_min_play: 1, squad_max_play: 1 },
      { id: 2, squad_select: 5, squad_min_play: 3, squad_max_play: 5 },
      { id: 5, squad_select: 0, squad_min_play: 0, squad_max_play: 0 },
    ],
    game_settings: { squad_team_limit: 3, squad_squadsize: 15 },
  });
  assert.equal(rules.xiMin[2], 3);
  assert.equal(rules.maxPerClub, 3);
  assert.equal(rules.squad[5], undefined);
});

// A pretend FPL API with made-up clubs and players. `npm run demo` and the
// tests use it so the app can be tried without touching a real FPL account.
// Response shapes follow the real API; the rules it enforces mirror the game's.

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const CLUBS = [
  ['Ashford Town', 'ASH'], ['Bramley City', 'BRM'], ['Calder United', 'CAL'], ['Dunmore Rovers', 'DUN'],
  ['Elmstead', 'ELM'], ['Fairhaven', 'FAI'], ['Glenwood', 'GLE'], ['Harrowgate Athletic', 'HGA'],
  ['Ironbridge', 'IRO'], ['Kingsmere', 'KNG'], ['Lowther', 'LOW'], ['Marston Vale', 'MSV'],
  ['Northfield', 'NFD'], ['Oakhurst', 'OAK'], ['Penrith Albion', 'PEN'], ['Queensport', 'QPT'],
  ['Redcliffe', 'RDC'], ['Stanmore', 'STN'], ['Thornbury', 'THB'], ['Westbrook Wanderers', 'WBW'],
];
const FIRST = ['Alex', 'Ben', 'Caleb', 'Dan', 'Eli', 'Femi', 'George', 'Harvey', 'Isaac', 'Jonah', 'Kian', 'Leo', 'Marco', 'Nico', 'Oscar', 'Pablo', 'Rafa', 'Sami', 'Theo', 'Victor', 'Wes', 'Yusuf', 'Zak', 'Ade', 'Bruno', 'Cian', 'Dario', 'Emil', 'Finn', 'Hugo'];
const LAST = ['Adeyemi', 'Barker', 'Castell', 'Doyle', 'Ekwueme', 'Fischer', 'Garnett', 'Holloway', 'Ibsen', 'Jansen', 'Kovac', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Pereira', 'Quinn', 'Rossi', 'Silva', 'Thorne', 'Ulloa', 'Vance', 'Whitlock', 'Yilmaz', 'Zielinski', 'Abara', 'Brennan', 'Costa', 'Dlamini', 'Eklund', 'Ferro', 'Gallo', 'Hartley', 'Ikande', 'Jurić', 'Kinsella', 'Lemaire', 'Mensah', 'Novak', 'Ortega'];
const SQUAD_SHAPE = { 1: 3, 2: 8, 3: 9, 4: 4 };
const PRICE = { 1: [40, 60], 2: [40, 70], 3: [45, 135], 4: [45, 150] };
const CURRENT_EVENT = 12;
const ENTRY_ID = 4815;
const CLIENT_ID = 'demo-client';
const FPL_WEB_CLIENT_ID = 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030'; // the real site's id, used by the in-app login
const CLIENT_IDS = new Set([CLIENT_ID, FPL_WEB_CLIENT_ID]);

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fx = (n) => n.toFixed(1);

function makeJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.${randomBytes(12).toString('base64url')}`;
}

export function buildWorld({ now = Date.now() } = {}) {
  const r = rng(20261120);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];

  const teams = CLUBS.map(([name, short], i) => ({
    id: i + 1,
    code: 900 + i,
    name,
    short_name: short,
    strength: 2 + Math.floor(r() * 4),
    position: 0,
    played: 0,
    win: 0,
    draw: 0,
    loss: 0,
    points: 0,
    unavailable: false,
  }));

  // Gameweeks: the next deadline is a couple of days away.
  const nextDeadline = now + ((2 * 24 + 5) * 60 + 17) * 60_000;
  const week = 7 * 24 * 3600_000;
  const events = [];
  for (let gw = 1; gw <= 38; gw++) {
    const deadline = nextDeadline + (gw - (CURRENT_EVENT + 1)) * week;
    events.push({
      id: gw,
      name: `Gameweek ${gw}`,
      deadline_time: iso(deadline),
      finished: gw < CURRENT_EVENT,
      data_checked: gw < CURRENT_EVENT,
      is_previous: gw === CURRENT_EVENT - 1,
      is_current: gw === CURRENT_EVENT,
      is_next: gw === CURRENT_EVENT + 1,
      average_entry_score: gw <= CURRENT_EVENT ? 40 + Math.floor(r() * 25) : 0,
      highest_score: gw <= CURRENT_EVENT ? 100 + Math.floor(r() * 40) : null,
      chip_plays: [],
    });
  }

  // Fixtures: a double round robin (circle method), one round per gameweek,
  // plus a blank and a double gameweek to make planning interesting.
  const ids = teams.map((t) => t.id);
  const rounds = [];
  let ring = ids.slice(1);
  for (let round = 0; round < 19; round++) {
    const line = [ids[0], ...ring];
    const games = [];
    for (let i = 0; i < 10; i++) {
      const a = line[i];
      const b = line[19 - i];
      games.push(round % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(games);
    ring = [ring[ring.length - 1], ...ring.slice(0, -1)];
  }
  const allRounds = [...rounds, ...rounds.map((g) => g.map(([h, a]) => [a, h]))];
  const strengthOf = (id) => teams[id - 1].strength;
  const fixtures = [];
  let fid = 1;
  allRounds.forEach((games, idx) => {
    const gw = idx + 1;
    games.forEach(([h, a], k) => {
      let event = gw;
      if (gw === 16 && k < 2) event = 17; // two games postponed: blank in GW16, double in GW17
      const deadline = Date.parse(events[gw - 1].deadline_time);
      const kickoff = deadline + (90 + (k % 4) * 150) * 60_000 + Math.floor(k / 4) * 24 * 3600_000;
      const finished = gw < CURRENT_EVENT || (gw === CURRENT_EVENT && k < 7);
      const hs = finished ? Math.floor(r() * 4) : null;
      const as = finished ? Math.floor(r() * 3) : null;
      fixtures.push({
        id: fid++,
        code: 7000 + fid,
        event,
        team_h: h,
        team_a: a,
        team_h_difficulty: Math.min(5, Math.max(2, strengthOf(a) + (r() < 0.2 ? 1 : 0))),
        team_a_difficulty: Math.min(5, Math.max(2, strengthOf(h) + (r() < 0.2 ? 1 : 0))),
        kickoff_time: iso(kickoff),
        started: finished,
        finished,
        finished_provisional: finished,
        minutes: finished ? 90 : 0,
        team_h_score: hs,
        team_a_score: as,
        stats: [],
      });
      if (finished) {
        const th = teams[h - 1];
        const ta = teams[a - 1];
        th.played++; ta.played++;
        if (hs > as) { th.win++; ta.loss++; th.points += 3; } else if (hs < as) { ta.win++; th.loss++; ta.points += 3; } else { th.draw++; ta.draw++; th.points++; ta.points++; }
      }
    });
  });
  [...teams].sort((a, b) => b.points - a.points).forEach((t, i) => { t.position = i + 1; });

  // Players
  const elements = [];
  let eid = 1;
  const usedNames = new Set();
  const usedWebNames = new Set();
  for (const team of teams) {
    for (const type of [1, 2, 3, 4]) {
      for (let n = 0; n < SQUAD_SHAPE[type]; n++) {
        let first;
        let last;
        do { first = pick(FIRST); last = pick(LAST); } while (usedNames.has(`${first} ${last}`));
        usedNames.add(`${first} ${last}`);
        const webName = usedWebNames.has(last) ? `${first[0]}.${last}` : last;
        usedWebNames.add(last);
        const [lo, hi] = PRICE[type];
        const quality = Math.pow(r(), n === 0 ? 0.6 : 1.8) * (0.7 + team.strength * 0.08);
        const cost = Math.round((lo + (hi - lo) * Math.min(1, quality)) / 5) * 5;
        const starter = n < (type === 1 ? 1 : type === 4 ? 2 : 5);
        const minutes = starter ? 700 + Math.floor(r() * 380) : Math.floor(r() * 300);
        const ppg = Math.max(0, (cost / 25) * (0.6 + r() * 0.6) * (starter ? 1 : 0.4));
        const total = Math.round(ppg * (CURRENT_EVENT - 1) * (minutes / 1080));
        const roll = r();
        const status = roll < 0.05 ? 'i' : roll < 0.1 ? 'd' : roll < 0.12 ? 's' : 'a';
        const chance = status === 'd' ? pick([25, 50, 75]) : status === 'a' ? null : 0;
        const news = {
          a: '',
          d: `Knock - ${chance}% chance of playing`,
          i: `Hamstring injury - Expected back ${new Date(now + (14 + Math.floor(r() * 30)) * 86400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
          s: 'Suspended for 1 match',
        }[status];
        const goals = type === 1 ? 0 : Math.floor((total / 10) * (type === 4 ? 0.9 : type === 3 ? 0.5 : 0.15) * r() * 2);
        const assists = type === 1 ? 0 : Math.floor((total / 12) * r());
        elements.push({
          id: eid,
          code: 50000 + eid,
          photo: `${50000 + eid}.jpg`,
          first_name: first,
          second_name: last,
          web_name: webName,
          team: team.id,
          team_code: team.code,
          element_type: type,
          now_cost: cost,
          cost_change_event: r() < 0.1 ? (r() < 0.5 ? -1 : 1) : 0,
          cost_change_start: Math.floor(r() * 5) - 2,
          status,
          chance_of_playing_next_round: chance,
          chance_of_playing_this_round: chance,
          news,
          total_points: total,
          event_points: Math.floor(r() * (starter ? 10 : 3)),
          points_per_game: fx(minutes ? (total / Math.max(1, Math.round(minutes / 90))) : 0),
          form: fx(Math.max(0, ppg * (0.5 + r()))),
          ep_next: fx(status === 'a' ? Math.max(0, ppg * (0.8 + r() * 0.4)) : 0),
          selected_by_percent: fx(Math.min(70, Math.pow(total / 100, 2) * 40 + r() * 3)),
          transfers_in_event: Math.floor(r() * 90000),
          transfers_out_event: Math.floor(r() * 60000),
          minutes,
          goals_scored: goals,
          assists,
          clean_sheets: type <= 2 && starter ? Math.floor(r() * 5) : 0,
          goals_conceded: type <= 2 ? Math.floor(r() * 15) : 0,
          saves: type === 1 && starter ? Math.floor(r() * 40) : 0,
          bonus: Math.floor(total / 15 * r()),
          bps: Math.floor(total * 3 * r()),
          expected_goals: fx(goals * (0.8 + r() * 0.4)),
          expected_assists: fx(assists * (0.8 + r() * 0.4)),
          expected_goal_involvements: fx((goals + assists) * (0.8 + r() * 0.4)),
          influence: fx(total * 4 * r()),
          creativity: fx(total * 3 * r()),
          threat: fx(total * 3 * r()),
          ict_index: fx(total * r()),
          starts: starter ? CURRENT_EVENT - 1 : 0,
          in_dreamteam: false,
          removed: false,
        });
        eid++;
      }
    }
  }

  const elementTypes = [1, 2, 3, 4].map((id) => ({
    id,
    plural_name: ['Goalkeepers', 'Defenders', 'Midfielders', 'Forwards'][id - 1],
    plural_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1],
    singular_name: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'][id - 1],
    singular_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1],
    squad_select: [2, 5, 5, 3][id - 1],
    squad_min_select: null,
    squad_max_select: null,
    squad_min_play: [1, 3, 2, 1][id - 1],
    squad_max_play: [1, 5, 5, 3][id - 1],
    element_count: elements.filter((e) => e.element_type === id).length,
  }));

  const bootstrap = {
    events,
    game_settings: { squad_squadplay: 11, squad_squadsize: 15, squad_team_limit: 3, squad_total_spend: 1000, transfers_cap: 5 },
    teams,
    total_players: 11_000_000,
    element_types: elementTypes,
    elements,
  };
  return { bootstrap, fixtures };
}

function chooseSquad(elements) {
  // Price targets per slot, cheapest last, so the squad is realistic and leaves
  // a little in the bank.
  const plan = [[1, 50], [1, 40], [2, 60], [2, 50], [2, 45], [2, 45], [2, 40], [3, 125], [3, 80], [3, 65], [3, 55], [3, 50], [4, 140], [4, 75], [4, 50]];
  const chosen = [];
  const perClub = new Map();
  for (const [type, target] of plan) {
    const options = elements
      .filter((e) => e.element_type === type && e.status === 'a' && !chosen.includes(e) && (perClub.get(e.team) ?? 0) < 2)
      .sort((a, b) => Math.abs(a.now_cost - target) - Math.abs(b.now_cost - target) || b.total_points - a.total_points);
    const e = options[0];
    chosen.push(e);
    perClub.set(e.team, (perClub.get(e.team) ?? 0) + 1);
  }
  return chosen;
}

export function createMockFpl({ now = Date.now() } = {}) {
  const { bootstrap, fixtures } = buildWorld({ now });
  const byId = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const nextEvent = bootstrap.events.find((e) => e.is_next).id;

  const squad = chooseSquad(bootstrap.elements);
  // Bench: second keeper (slot 12) and the three cheapest outfielders.
  const order = [squad[0], squad[2], squad[3], squad[4], squad[5], squad[7], squad[8], squad[9], squad[10], squad[12], squad[13], squad[1], squad[11], squad[6], squad[14]];
  const picks = order.map((e, i) => {
    const bought = i % 4 === 0 ? e.now_cost - 3 : e.now_cost;
    const selling = e.now_cost > bought ? bought + Math.floor((e.now_cost - bought) / 2) : e.now_cost;
    return {
      element: e.id,
      position: i + 1,
      selling_price: selling,
      multiplier: i === 9 ? 2 : i < 11 ? 1 : 0,
      purchase_price: bought,
      is_captain: i === 9,
      is_vice_captain: i === 5,
      element_type: e.element_type,
    };
  });
  const squadValue = picks.reduce((s, p) => s + p.selling_price, 0);

  const state = {
    picks,
    bank: Math.max(0, 1000 - squadValue),
    transfers: { cost: 4, status: 'cost', limit: 2, made: 0 },
    chips: [
      ['wildcard', 1, 2, 19, 'transfer', 'available', []],
      ['freehit', 1, 2, 19, 'transfer', 'available', []],
      ['bboost', 1, 1, 19, 'team', 'available', []],
      ['3xc', 1, 1, 19, 'team', 'played', [{ event: 5 }]],
      ['wildcard', 2, 20, 38, 'transfer', 'unavailable', []],
      ['freehit', 2, 20, 38, 'transfer', 'unavailable', []],
      ['bboost', 2, 20, 38, 'team', 'unavailable', []],
      ['3xc', 2, 20, 38, 'team', 'unavailable', []],
    ].map(([name, number, start, stop, type, status, played], i) => ({
      id: i + 1, name, number, start_event: start, stop_event: stop, chip_type: type,
      status_for_entry: status, played_by_entry: played.map((p) => p.event), is_pending: false,
    })),
    lastPicksUpdate: iso(now - 3 * 86400_000),
    log: [],
  };
  // Picks for the gameweek in progress (public endpoint) are a snapshot.
  const currentPicks = picks.map(({ element, position, multiplier, is_captain, is_vice_captain, element_type }) => ({ element, position, multiplier, is_captain, is_vice_captain, element_type }));

  // Live points for every gameweek played so far (made up, but stable).
  const liveCache = new Map();
  const liveFor = (gw) => {
    if (!liveCache.has(gw)) {
      const r = rng(77 + gw);
      const rows = bootstrap.elements.map((e) => {
        const played = e.status === 'a' && r() < 0.75;
        const minutes = played ? (r() < 0.8 ? 90 : 20 + Math.floor(r() * 60)) : 0;
        const goals = played && e.element_type > 1 && r() < (e.element_type === 4 ? 0.35 : e.element_type === 3 ? 0.2 : 0.06) ? 1 : 0;
        const assists = played && r() < 0.15 ? 1 : 0;
        const cs = played && e.element_type <= 2 && r() < 0.3 ? 1 : 0;
        const bonus = played && r() < 0.1 ? 1 + Math.floor(r() * 3) : 0;
        const pts = !played ? 0 : (minutes >= 60 ? 2 : 1) + goals * [0, 10, 6, 5, 4][e.element_type] + assists * 3 + cs * (e.element_type <= 2 ? 4 : 0) + bonus;
        return { id: e.id, stats: { minutes, goals_scored: goals, assists, clean_sheets: cs, bonus, total_points: pts }, explain: [] };
      });
      liveCache.set(gw, { rows, byId: new Map(rows.map((l) => [l.id, l])) });
    }
    return liveCache.get(gw);
  };
  const gwPointsFor = (gw) => currentPicks.reduce((s, p) => s + liveFor(gw).byId.get(p.element).stats.total_points * p.multiplier, 0);
  const gwPoints = gwPointsFor(CURRENT_EVENT);

  // ----- auth (shaped like the PingOne refresh grant) -----
  const accessTokens = new Map();
  const refreshTokens = new Set();
  const authCodes = new Map();
  const issue = (ttlS = 8 * 3600) => {
    const exp = Math.floor(Date.now() / 1000) + ttlS;
    const access = makeJwt({ sub: 'demo-user', exp, aud: CLIENT_ID });
    accessTokens.set(access, exp);
    const refresh = randomBytes(24).toString('base64url');
    refreshTokens.add(refresh);
    return { access, refresh, exp };
  };
  const authed = (req) => {
    const header = req.headers['x-api-authorization'] ?? '';
    const m = /^Bearer (.+)$/i.exec(header);
    if (!m) return false;
    const exp = accessTokens.get(m[1]);
    return Boolean(exp && exp > Date.now() / 1000);
  };

  const entryInfo = () => ({
    id: ENTRY_ID,
    joined_time: iso(now - 120 * 86400_000),
    started_event: 1,
    player_first_name: 'Demo',
    player_last_name: 'Manager',
    player_region_name: 'England',
    name: 'Demo Dynamos',
    summary_overall_points: 640 + gwPoints,
    summary_overall_rank: 412_118,
    summary_event_points: gwPoints,
    summary_event_rank: 2_104_552,
    current_event: CURRENT_EVENT,
    last_deadline_bank: state.bank,
    last_deadline_value: squadValue + state.bank,
    last_deadline_total_transfers: 9,
  });

  const myTeam = () => ({
    picks: state.picks.map((p) => ({ ...p })),
    picks_last_updated: state.lastPicksUpdate,
    chips: state.chips.map((c) => ({ ...c })),
    transfers: {
      ...state.transfers,
      bank: state.bank,
      value: state.picks.reduce((s, p) => s + byId.get(p.element).now_cost, 0),
    },
  });

  const fail = (msg) => ({ status: 400, body: { errors: [msg] } });
  const typeOf = (id) => byId.get(id)?.element_type;

  function saveLineup(body) {
    if (!Array.isArray(body?.picks) || body.picks.length !== 15) return fail('A team must have 15 players.');
    const current = new Set(state.picks.map((p) => p.element));
    const ids = body.picks.map((p) => p.element);
    if (new Set(ids).size !== 15 || ids.some((id) => !current.has(id))) return fail('Picks must be the players in your squad.');
    const positions = body.picks.map((p) => p.position).sort((a, b) => a - b);
    if (positions.join() !== Array.from({ length: 15 }, (_, i) => i + 1).join()) return fail('Positions must be 1 to 15.');
    const starters = body.picks.filter((p) => p.position <= 11).map((p) => typeOf(p.element));
    const count = (t) => starters.filter((x) => x === t).length;
    if (count(1) !== 1 || count(2) < 3 || count(2) > 5 || count(3) < 2 || count(3) > 5 || count(4) < 1 || count(4) > 3) return fail('Invalid formation.');
    const benchGk = body.picks.find((p) => p.position === 12);
    if (typeOf(benchGk.element) !== 1) return fail('Your substitute goalkeeper must be first on the bench.');
    const caps = body.picks.filter((p) => p.is_captain);
    const vices = body.picks.filter((p) => p.is_vice_captain);
    if (caps.length !== 1 || vices.length !== 1 || caps[0].element === vices[0].element) return fail('Choose one captain and one vice-captain.');
    if (caps[0].position > 11 || vices[0].position > 11) return fail('Captains must be in the starting line-up.');
    if (body.chip) {
      const chip = state.chips.find((c) => c.name === body.chip && c.start_event <= nextEvent && c.stop_event >= nextEvent);
      if (!chip || chip.chip_type !== 'team') return fail('That chip cannot be played from this page.');
      const active = state.chips.find((c) => c.status_for_entry === 'active');
      if (active && active !== chip) return fail('You can only play one chip each gameweek.');
      if (chip.status_for_entry !== 'available' && chip.status_for_entry !== 'active') return fail('That chip is not available.');
      Object.assign(chip, { status_for_entry: 'active', is_pending: true });
    } else {
      const active = state.chips.find((c) => c.status_for_entry === 'active' && c.chip_type === 'team');
      if (active) Object.assign(active, { status_for_entry: 'available', is_pending: false });
    }
    const prev = new Map(state.picks.map((p) => [p.element, p]));
    state.picks = body.picks
      .map((p) => ({
        ...prev.get(p.element),
        position: p.position,
        is_captain: Boolean(p.is_captain),
        is_vice_captain: Boolean(p.is_vice_captain),
      }))
      .sort((a, b) => a.position - b.position)
      .map((p) => {
        const triple = state.chips.some((c) => c.name === '3xc' && c.status_for_entry === 'active');
        const boost = state.chips.some((c) => c.name === 'bboost' && c.status_for_entry === 'active');
        return { ...p, multiplier: p.is_captain ? (triple ? 3 : 2) : p.position <= 11 || boost ? 1 : 0 };
      });
    state.lastPicksUpdate = iso(Date.now());
    state.log.push({ type: 'lineup', body });
    return { status: 200, body: myTeam() };
  }

  function makeTransfers(body) {
    if (body?.entry !== ENTRY_ID) return fail('Entry does not match your team.');
    if (body?.event !== nextEvent) return fail(`Transfers are for gameweek ${nextEvent}.`);
    const list = body.transfers;
    if (!Array.isArray(list) || (list.length === 0 && !body.chip)) return fail('No transfers given.');
    let chip = null;
    if (body.chip) {
      chip = state.chips.find((c) => c.name === body.chip && c.chip_type === 'transfer' && c.start_event <= nextEvent && c.stop_event >= nextEvent);
      if (!chip || chip.status_for_entry !== 'available') return fail('That chip is not available.');
      if (state.chips.some((c) => c.status_for_entry === 'active')) return fail('You can only play one chip each gameweek.');
    }
    const working = state.picks.map((p) => ({ ...p }));
    let bank = state.bank;
    for (const t of list) {
      const out = working.find((p) => p.element === t.element_out);
      const incoming = byId.get(t.element_in);
      if (!out) return fail('You can only sell players in your squad.');
      if (!incoming) return fail('Unknown player.');
      if (working.some((p) => p.element === incoming.id)) return fail(`${incoming.web_name} is already in your squad.`);
      if (incoming.element_type !== typeOf(out.element)) return fail('Players must be swapped for the same position.');
      if (t.purchase_price !== incoming.now_cost) return { status: 400, body: { transfers: [{ non_field_errors: [{ code: 'transfer_element_in_price_mismatch' }] }] } };
      if (t.selling_price !== out.selling_price) return { status: 400, body: { transfers: [{ non_field_errors: [{ code: 'transfer_element_out_price_mismatch' }] }] } };
      bank += out.selling_price - incoming.now_cost;
      Object.assign(out, { element: incoming.id, purchase_price: incoming.now_cost, selling_price: incoming.now_cost, element_type: incoming.element_type });
    }
    if (bank < 0) return fail('You do not have enough money in the bank.');
    const perClub = new Map();
    for (const p of working) {
      const team = byId.get(p.element).team;
      perClub.set(team, (perClub.get(team) ?? 0) + 1);
      if (perClub.get(team) > 3) return fail('You already have the maximum number of players from that club.');
    }
    state.picks = working;
    state.bank = bank;
    if (chip) {
      Object.assign(chip, { status_for_entry: 'active', is_pending: true });
      state.transfers = { ...state.transfers, limit: null, status: 'unlimited' };
    }
    state.transfers.made += list.length;
    state.log.push({ type: 'transfers', body });
    return { status: 200, body: {} };
  }

  function elementSummary(id) {
    const e = byId.get(id);
    if (!e) return null;
    const hr = rng(id * 31);
    const history = fixtures
      .filter((f) => f.finished && (f.team_h === e.team || f.team_a === e.team))
      .map((f) => {
        const home = f.team_h === e.team;
        const pts = e.minutes > 300 ? Math.max(0, Math.round(e.total_points / (CURRENT_EVENT - 1) + (hr() - 0.5) * 6)) : (hr() < 0.3 ? 1 : 0);
        return {
          element: id, fixture: f.id, opponent_team: home ? f.team_a : f.team_h, was_home: home,
          round: f.event, kickoff_time: f.kickoff_time, total_points: pts,
          minutes: pts > 0 ? 90 : 0, team_h_score: f.team_h_score, team_a_score: f.team_a_score,
          value: e.now_cost,
        };
      });
    const upcoming = fixtures
      .filter((f) => !f.finished && (f.team_h === e.team || f.team_a === e.team))
      .map((f) => ({
        id: f.id, event: f.event, team_h: f.team_h, team_a: f.team_a, is_home: f.team_h === e.team,
        difficulty: f.team_h === e.team ? f.team_h_difficulty : f.team_a_difficulty, kickoff_time: f.kickoff_time,
        finished: false,
      }));
    return { fixtures: upcoming, history, history_past: [] };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    };

    if (p === '/as/.well-known/openid-configuration') {
      return json(200, { issuer: `${baseUrl}/as`, token_endpoint: `${baseUrl}/as/token` });
    }
    // Sign-in page: pretends the user logged in and sends them back with a code.
    if (p === '/as/authorize') {
      const q = url.searchParams;
      if (!CLIENT_IDS.has(q.get('client_id')) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return json(400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('base64url');
      authCodes.set(code, { challenge: q.get('code_challenge'), clientId: q.get('client_id'), redirectUri: q.get('redirect_uri') });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (p === '/as/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody());
      if (!CLIENT_IDS.has(form.get('client_id'))) return json(400, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const pending = authCodes.get(form.get('code'));
        authCodes.delete(form.get('code'));
        const verifierHash = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!pending || pending.clientId !== form.get('client_id') || pending.redirectUri !== form.get('redirect_uri') || pending.challenge !== verifierHash) {
          return json(400, { error: 'invalid_grant', error_description: 'The authorization code is invalid.' });
        }
        const t = issue();
        state.log.push({ type: 'login' });
        return json(200, { access_token: t.access, refresh_token: t.refresh, id_token: 'x.y.z', token_type: 'Bearer', expires_in: 8 * 3600 });
      }
      if (form.get('grant_type') !== 'refresh_token') return json(400, { error: 'unsupported_grant_type' });
      const token = form.get('refresh_token');
      if (!refreshTokens.has(token)) return json(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid or has been used.' });
      refreshTokens.delete(token); // rotate
      const t = issue();
      state.log.push({ type: 'refresh' });
      return json(200, { access_token: t.access, refresh_token: t.refresh, token_type: 'Bearer', expires_in: 8 * 3600, scope: 'openid profile email offline_access' });
    }

    if (p === '/api/bootstrap-static/') return json(200, bootstrap);
    if (p === '/api/fixtures/') {
      const ev = url.searchParams.get('event');
      return json(200, ev ? fixtures.filter((f) => f.event === Number(ev)) : fixtures);
    }
    let m;
    if ((m = /^\/api\/element-summary\/(\d+)\/$/.exec(p))) {
      const s = elementSummary(Number(m[1]));
      return s ? json(200, s) : json(404, { detail: 'Not found.' });
    }
    if ((m = /^\/api\/event\/(\d+)\/live\/$/.exec(p))) {
      const gw = Number(m[1]);
      return gw >= 1 && gw <= CURRENT_EVENT ? json(200, { elements: liveFor(gw).rows }) : json(200, { elements: [] });
    }
    if ((m = /^\/api\/entry\/(\d+)\/$/.exec(p))) {
      return Number(m[1]) === ENTRY_ID ? json(200, entryInfo()) : json(404, { detail: 'Not found.' });
    }
    if ((m = /^\/api\/entry\/(\d+)\/event\/(\d+)\/picks\/$/.exec(p))) {
      const gw = Number(m[2]);
      if (Number(m[1]) !== ENTRY_ID || gw < 1 || gw > CURRENT_EVENT) return json(404, { detail: 'Not found.' });
      const points = gwPointsFor(gw);
      const live = liveFor(gw).byId;
      return json(200, {
        active_chip: gw === 5 ? '3xc' : null,
        automatic_subs: [],
        entry_history: {
          event: gw, points, total_points: 640 + gwPoints, rank: 1_500_000 + gw * 37_211, overall_rank: 412_118,
          bank: state.bank, value: squadValue + state.bank, event_transfers: gw % 3 === 0 ? 2 : 1, event_transfers_cost: gw % 3 === 0 ? 4 : 0,
          points_on_bench: currentPicks.filter((x) => x.position > 11).reduce((s, x) => s + live.get(x.element).stats.total_points, 0),
        },
        picks: currentPicks,
      });
    }
    if (p === '/api/me/') {
      if (!authed(req)) return json(200, { player: null, watched: [] });
      return json(200, { player: { first_name: 'Demo', last_name: 'Manager', entry: ENTRY_ID, id: 99, region: 241 }, watched: [] });
    }
    if ((m = /^\/api\/my-team\/(\d+)\/$/.exec(p))) {
      if (!authed(req)) return json(403, { detail: 'Authentication credentials were not provided.' });
      if (Number(m[1]) !== ENTRY_ID) return json(403, { detail: 'You do not have permission to perform this action.' });
      if (req.method === 'GET') return json(200, myTeam());
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody()); } catch { return json(400, { errors: ['Bad JSON'] }); }
        const out = saveLineup(body);
        return json(out.status, out.body);
      }
    }
    if (p === '/api/transfers/' && req.method === 'POST') {
      if (!authed(req)) return json(403, { detail: 'Authentication credentials were not provided.' });
      let body;
      try { body = JSON.parse(await readBody()); } catch { return json(400, { errors: ['Bad JSON'] }); }
      const out = makeTransfers(body);
      return json(out.status, out.body);
    }
    return json(404, { detail: 'Not found.' });
  }

  let baseUrl = '';
  return {
    state,
    bootstrap,
    fixtures,
    entryId: ENTRY_ID,
    nextEvent,
    handle,
    setBaseUrl(url) { baseUrl = url; },
    issue,
    get baseUrl() { return baseUrl; },
  };
}

export async function startMockFpl({ port = 0, now } = {}) {
  const mock = createMockFpl({ now });
  const server = http.createServer((req, res) => {
    mock.handle(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: String(err) }));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  mock.setBaseUrl(url);
  return {
    url,
    mock,
    // A logged-in session for demo mode.
    demoSession() {
      const t = mock.issue();
      return { kind: 'auth', entry: ENTRY_ID, name: 'Demo Manager', access_token: t.access, refresh_token: t.refresh, expires_at: t.exp, authority: `${url}/as`, client_id: CLIENT_ID };
    },
    // What the console snippet would copy: an expired access token plus a
    // refresh token, so connecting exercises the refresh flow.
    loginBlob() {
      const t = mock.issue(-60);
      return { authority: `${url}/as`, client_id: CLIENT_ID, access_token: t.access, refresh_token: t.refresh, expires_at: t.exp };
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

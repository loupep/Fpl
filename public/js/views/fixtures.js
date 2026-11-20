// Fixtures: a difficulty ticker for every club over the coming gameweeks.

import { upcoming } from '../data.js';
import { esc, fdrClass } from '../ui.js';

export function render(root, app) {
  const { d, team } = app;
  const from = d.next?.id ?? d.current?.id ?? 1;
  const span = Number(app.pref.get('fx.span')) || 6;
  const sort = app.pref.get('fx.sort') || 'easy';
  const count = Math.max(1, Math.min(span, d.events.length - from + 1));

  const owned = new Map();
  for (const p of team.picks) {
    const t = d.teamOf(p.element);
    owned.set(t, (owned.get(t) ?? 0) + 1);
  }

  const rows = [...d.teams.values()].map((t) => {
    const runs = upcoming(d, t.id, count, from);
    let score = 0;
    let games = 0;
    for (const r of runs) {
      if (!r.fixtures.length) score += 5;
      for (const f of r.fixtures) { score += f.difficulty; games++; }
    }
    const extra = games - runs.length; // doubles minus blanks
    return { t, runs, ease: score / Math.max(1, runs.length) - extra * 0.75 };
  });
  rows.sort(sort === 'name' ? (a, b) => a.t.name.localeCompare(b.t.name) : (a, b) => a.ease - b.ease || a.t.name.localeCompare(b.t.name));

  const header = Array.from({ length: count }, (_, i) => `<th scope="col">GW${from + i}</th>`).join('');
  const body = rows.map(({ t, runs }) => {
    const mine = owned.get(t.id);
    const cells = runs.map(({ fixtures }) => {
      const label = fixtures.length
        ? fixtures.map((f) => `<span>${esc(d.teams.get(f.opp)?.short_name ?? '?')}<small>${f.home ? 'H' : 'A'}</small></span>`).join('')
        : '<span>–</span>';
      return `<td class="fx-cell ${fixtures.length > 1 ? 'fx-double' : ''} ${fdrClass(fixtures)}">${label}</td>`;
    }).join('');
    return `<tr><th scope="row"><span class="club-name">${esc(t.name)}</span>${mine ? `<span class="owned" title="${mine} of your players">${mine}</span>` : ''}</th>${cells}</tr>`;
  }).join('');

  root.innerHTML = `
    <section class="view view-fixtures">
      <div class="view-head">
        <div>
          <h1>Fixtures</h1>
          <p class="muted">How hard each club's next games look. Green is easier, red is harder. Numbers show how many of your players are at each club.</p>
        </div>
        <div class="row-gap">
          <select data-span aria-label="Gameweeks to show">${[3, 5, 6, 8, 10].map((n) => `<option value="${n}" ${span === n ? 'selected' : ''}>Next ${n} GWs</option>`).join('')}</select>
          <select data-sort aria-label="Sort clubs"><option value="easy" ${sort === 'easy' ? 'selected' : ''}>Easiest first</option><option value="name" ${sort === 'name' ? 'selected' : ''}>By name</option></select>
        </div>
      </div>
      <div class="table-scroll">
        <table class="fdr-table"><thead><tr><th scope="col">Club</th>${header}</tr></thead><tbody>${body}</tbody></table>
      </div>
      <div class="fdr-legend" aria-label="Difficulty key"><span>Easier</span>${[1, 2, 3, 4, 5].map((n) => `<span class="fdr-${n}">${n}</span>`).join('')}<span>Harder</span></div>
    </section>`;

  root.onchange = (e) => {
    if (e.target.matches('[data-span]')) app.pref.set('fx.span', e.target.value);
    if (e.target.matches('[data-sort]')) app.pref.set('fx.sort', e.target.value);
    app.render();
  };
}

// Clicks through the app in a real browser against the demo league.
// Needs Playwright with Chromium; skipped when it isn't installed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch { /* not installed */ }

const skip = chromium ? false : 'Playwright is not installed';
let server;
let base;
let browser;
let page;
const problems = [];

before(async () => {
  if (skip) return;
  server = spawn(process.execPath, ['server.js', '--demo'], { cwd: ROOT, env: { ...process.env, PORT: '0' } });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
    server.stdout.on('data', (chunk) => {
      const m = /http:\/\/localhost:\d+/.exec(String(chunk));
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(base);
  await page.waitForSelector('.view-team .pcard');
});

after(async () => {
  await browser?.close();
  server?.kill();
});

const myTeam = () => page.evaluate(() => fetch('/api/fpl/my-team/4815/').then((r) => r.json()));
const toastText = async () => (await page.waitForSelector('.toast.show')).textContent();
const dismissToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

test('pick team: substitute, change captain and save', { skip }, async () => {
  const before = await myTeam();
  const captain = before.picks.find((p) => p.is_captain).element;
  const benchMid = before.picks.find((p) => p.position === 13).element;

  await page.click(`.pitch .pcard[data-id="${captain}"]`);
  await page.click('.modal [data-action="sub"]');
  await page.waitForSelector('.banner');
  assert.ok(await page.$(`.bench .pcard.is-target[data-id="${benchMid}"]`), 'bench midfielder is a valid swap');
  await page.click(`.bench .pcard[data-id="${benchMid}"]`);
  assert.match(await page.textContent('.view-head p'), /4-5-1/);
  assert.ok(await page.$(`.pitch .pcard[data-id="${benchMid}"] .armband`), 'armband moved to the incoming player');

  // Make a defender captain instead.
  const defender = before.picks.find((p) => p.position === 2).element;
  await page.click(`.pitch .pcard[data-id="${defender}"]`);
  await page.click('.modal [data-action="cap"]');
  await page.click('[data-action="save"]');
  assert.match(await toastText(), /Team saved/);
  await dismissToasts();

  const after = await myTeam();
  assert.equal(after.picks.find((p) => p.is_captain).element, defender);
  assert.equal(after.picks.find((p) => p.element === benchMid).position <= 11, true);
  assert.equal(after.picks.find((p) => p.element === captain).position, 13);
});

test('pick team: an illegal swap is refused with a reason', { skip }, async () => {
  const team = await myTeam();
  const keeper = team.picks.find((p) => p.position === 1).element;
  const benchOutfield = team.picks.find((p) => p.position === 14).element;
  await page.click(`.pitch .pcard[data-id="${keeper}"]`);
  await page.click('.modal [data-action="sub"]');
  assert.ok(await page.$(`.bench .pcard.is-dim[data-id="${benchOutfield}"]`));
  await page.click(`.bench .pcard[data-id="${benchOutfield}"]`);
  assert.match(await toastText(), /Goalkeepers can only swap with goalkeepers/);
  await page.click('[data-action="cancel-sub"]');
  await dismissToasts();
});

test('transfers: replace a defender, see the budget, confirm with FPL', { skip }, async () => {
  const before = await myTeam();
  await page.click('[data-view="transfers"]');
  await page.waitForSelector('.market-list .mrow');
  assert.match(await page.textContent('.stat-strip'), /Free transfers\s*2/);

  const out = before.picks.find((p) => p.element_type === 2 && p.position <= 11);
  await page.click(`.squad-panel .pcard[data-id="${out.element}"]`);
  assert.match(await page.textContent('[data-market-head]'), /Replacing/);
  assert.equal(await page.inputValue('select[name="type"]'), '2', 'list filtered to defenders');

  const target = await page.$eval('.market-list .mrow:not(.is-blocked):not(.is-owned) [data-pick]', (b) => Number(b.dataset.pick));
  await page.click(`.market-list [data-pick="${target}"]`);
  await page.waitForSelector('.pending li');
  await dismissToasts();
  assert.ok(await page.$(`.squad-panel .pcard.is-in[data-id="${target}"]`));

  const bankShown = await page.textContent('.stat-strip > div:nth-child(3) strong');
  await page.click('[data-action="confirm"]');
  await page.waitForSelector('.modal .confirm-table');
  await page.click('.modal [data-action="ok"]');
  assert.match(await toastText(), /1 transfer made/);
  await dismissToasts();

  const after = await myTeam();
  assert.ok(after.picks.some((p) => p.element === target));
  assert.ok(!after.picks.some((p) => p.element === out.element));
  assert.equal(after.transfers.made, 1);
  assert.equal(`£${(after.transfers.bank / 10).toFixed(1)}m`, bankShown, 'bank matches what the app predicted');
  assert.equal(after.picks.find((p) => p.element === target).position, out.position, 'new player takes the same slot');
});

test('transfers: going past the free transfers shows a points hit, and undo clears it', { skip }, async () => {
  const team = await myTeam();
  const mids = team.picks.filter((p) => p.element_type === 3).slice(-2);
  for (const p of mids) {
    await page.click(`.squad-panel .pcard[data-id="${p.element}"]`);
    await page.waitForSelector('[data-action="clear-out"]');
    const id = await page.$eval('.market-list .mrow:not(.is-blocked):not(.is-owned) [data-pick]', (b) => Number(b.dataset.pick));
    await page.click(`.market-list [data-pick="${id}"]`);
    await dismissToasts();
  }
  assert.equal(await page.locator('.pending li').count(), 2);
  assert.match(await page.textContent('.stat-strip'), /-4 pts/);
  await page.click('.pending [data-undo]');
  assert.match(await page.textContent('.stat-strip'), /Points cost\s*0 pts/);
  await page.click('[data-action="reset"]');
  assert.equal(await page.locator('.pending li').count(), 0);
});

test('chips: playing Bench Boost blocks the transfer chips', { skip }, async () => {
  await page.click('[data-view="team"]');
  await page.click('[data-chip="bboost"]');
  await page.click('.modal [data-action="ok"]');
  await page.click('[data-action="save"]');
  assert.match(await toastText(), /Team saved/);
  await dismissToasts();
  const team = await myTeam();
  assert.equal(team.chips.find((c) => c.name === 'bboost' && c.number === 1).status_for_entry, 'active');
  assert.ok(await page.$('.bench.is-boosted'));
  await page.click('[data-view="transfers"]');
  assert.equal(await page.isDisabled('[data-chip="wildcard"]'), true);
  assert.equal(await page.isDisabled('[data-chip="freehit"]'), true);
});

test('points and fixtures pages render', { skip }, async () => {
  await page.click('[data-view="points"]');
  await page.waitForSelector('.view-points .pts-tag');
  assert.equal(await page.locator('.view-points .pcard').count(), 15);
  await page.click('[data-gw="11"]');
  await page.waitForSelector('.view-points .pts-tag');
  assert.match(await page.textContent('.view-points .view-head p'), /Gameweek 11/);
  await page.click('[data-view="fixtures"]');
  assert.equal(await page.locator('.fdr-table tbody tr').count(), 20);
});

test('log out, then log back in with a pasted (expired) login that has to be renewed', { skip }, async () => {
  await page.click('[data-action="account"]');
  await page.click('.modal [data-action="disconnect"]');
  await page.waitForSelector('.connect');
  await page.click('[data-action="demo"]');
  await page.waitForFunction(() => document.querySelector('#login-input').value.includes('refresh_token'));
  await page.click('[data-form="login"] [type="submit"]');
  await page.waitForSelector('#tabs:not([hidden]) [data-view]');
  const session = await page.evaluate(() => fetch('/api/session').then((r) => r.json()));
  assert.equal(session.mode, 'auth');
  assert.ok(session.expiresAt > Date.now() / 1000, 'the access token was renewed');
});

test('view-only mode with a team ID', { skip }, async () => {
  await page.click('[data-action="account"]');
  await page.click('.modal [data-action="disconnect"]');
  await page.fill('#team-id', '4815');
  await page.click('[data-form="public"] [type="submit"]');
  await page.click('[data-view="team"]');
  await page.waitForSelector('.view-team .pcard');
  assert.match(await page.textContent('.view-team .note'), /View only/);
  assert.equal(await page.isDisabled('[data-action="save"]'), true);
  await page.click('[data-view="transfers"]');
  assert.ok(await page.$('select[data-free]'), 'free transfers can be set by hand');
});

test('other websites cannot use the local server', { skip }, async () => {
  const { port } = new URL(base);
  const status = (headers, method = 'GET', body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: method === 'GET' ? '/api/session' : '/api/fpl/transfers/', method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await status({ Host: `localhost:${port}` }), 200);
  assert.equal(await status({ Host: 'evil.example' }), 403, 'DNS rebinding');
  assert.equal(await status({ Host: `localhost:${port}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, 'POST', '{}'), 403, 'cross-site POST');
  assert.equal(await status({ Host: `localhost:${port}`, 'Content-Type': 'text/plain' }, 'POST', '{}'), 403, 'simple-request POST');
});

test('no errors in the browser console', { skip }, () => {
  assert.deepEqual(problems, []);
});

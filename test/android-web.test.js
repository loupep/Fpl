// Runs the app the way the Android app does: served from
// https://appassets.androidplatform.net with FPL requests going through the
// /__native/ routes and window.FplNative. This test stands in for the Java
// layer (android/app/src/main/java/.../NativeRoutes.java and LoginActivity.java)
// and talks to the pretend FPL instead of the real one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockFpl } from '../mock/mock-fpl.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://appassets.androidplatform.net';
let playwright = null;
try { playwright = createRequire(import.meta.url)('playwright'); } catch { /* not installed */ }
const skip = playwright ? false : 'Playwright is not installed';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
let mock;
let browser;
let context;
let page;
let storedSession = null;
const problems = [];
const nativeCalls = [];

async function nativeRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const headers = req.headers();
  if (url.pathname === '/__native/session') {
    if (req.method() === 'GET') return storedSession ? route.fulfill({ status: 200, body: storedSession }) : route.fulfill({ status: 204, body: '' });
    storedSession = headers['x-fplm-body'] ? Buffer.from(headers['x-fplm-body'], 'base64').toString('utf8') : null;
    return route.fulfill({ status: 204, body: '' });
  }
  const m = /^\/__native\/fpl\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (m) {
    const [, host, rest] = m;
    if (!/(^|\.)premierleague\.com$|^127\.0\.0\.1:\d+$/.test(host)) return route.fulfill({ status: 403, body: '{"detail":"Host not allowed"}' });
    nativeCalls.push(`${req.method()} ${host}${rest}`);
    const out = {};
    for (const k of ['accept', 'content-type', 'x-api-authorization']) if (headers[k]) out[k] = headers[k];
    const body = headers['x-fplm-body'] ? Buffer.from(headers['x-fplm-body'], 'base64') : undefined;
    const res = await fetch(`${mock.url}${rest}${url.search}`, { method: req.method(), headers: out, body, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"FPL redirected the request, which usually means your login was not accepted. Log in again."}' });
    return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(path.join(ROOT, 'public', rel));
    return route.fulfill({ status: 200, contentType: MIME[path.extname(rel)] ?? 'application/octet-stream', body });
  } catch {
    return route.fulfill({ status: 404, body: 'Not found' });
  }
}

// What LoginActivity does: shows FPL's login page and reports where it sent
// the user back to (or, in website mode, the login the site stored).
async function fakeLoginScreen(json) {
  const request = JSON.parse(json);
  nativeCalls.push(`login:${request.mode}`);
  if (request.mode === 'site') return { login: mock.loginBlob() };
  const u = new URL(request.url);
  assert.equal(u.host, 'account.premierleague.com');
  const res = await fetch(`${mock.url}${u.pathname}${u.search}`, { redirect: 'manual' });
  const location = res.headers.get('location');
  assert.ok(location?.startsWith(request.redirect), 'sent back to the FPL site address');
  return { url: location };
}

const BRIDGE = () => {
  window.FplNative = {
    startLogin(json) {
      window.__fakeLogin(json).then((result) => {
        window.__loginResult = JSON.stringify(result);
        window.fplmNativeLoginDone();
      });
    },
    takeLoginResult() {
      const r = window.__loginResult ?? null;
      window.__loginResult = null;
      return r;
    },
    clearLoginData() { window.__cleared = (window.__cleared ?? 0) + 1; },
  };
};

async function newPage() {
  const p = await context.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  p.on('console', (msg) => { if (msg.type() === 'error' && !/status of 4\d\d/.test(msg.text())) problems.push(`console: ${msg.text()}`); });
  return p;
}

before(async () => {
  if (skip) return;
  mock = await startMockFpl();
  browser = await playwright.chromium.launch();
  context = await browser.newContext({ ...playwright.devices['Pixel 7'], reducedMotion: 'reduce' });
  await context.route(`${ORIGIN}/**`, nativeRoute);
  await context.exposeFunction('__fakeLogin', fakeLoginScreen);
  await context.addInitScript(BRIDGE);
  page = await newPage();
  await page.goto(`${ORIGIN}/index.html`);
});

after(async () => {
  await browser?.close();
  await mock?.close();
});

const myTeam = () => mock.mock.state;
const toastText = async (p = page) => (await p.waitForSelector('.toast.show')).textContent();
const dismissToasts = (p = page) => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

test('android: the login screen offers in-app login, not the console snippet', { skip }, async () => {
  await page.waitForSelector('.connect');
  assert.ok(await page.$('[data-action="native-login"]'));
  assert.equal(await page.$('.snippet'), null);
  assert.match(await page.textContent('.connect-intro'), /stays on this phone/);
});

test('android: logging in with FPL signs in through the login page and loads the team', { skip }, async () => {
  await page.click('[data-action="native-login"]');
  await page.waitForSelector('.view-team .pcard');
  assert.match(await toastText(), /Logged in as Demo Manager/);
  await dismissToasts();
  assert.ok(nativeCalls.includes('login:oauth'));
  assert.ok(nativeCalls.some((c) => c.startsWith('POST account.premierleague.com/as/token') || /POST 127\.0\.0\.1:\d+\/as\/token/.test(c)), 'code exchanged for tokens');
  assert.ok(mock.mock.state.log.some((l) => l.type === 'login'));
  const saved = JSON.parse(storedSession);
  assert.equal(saved.kind, 'auth');
  assert.equal(saved.entry, mock.mock.entryId);
  assert.ok(saved.refresh_token, 'keeps a refresh token so the login lasts');
  assert.equal(await page.$('#tabs[hidden]'), null);
});

test('android: saving the team goes to FPL from the phone', { skip }, async () => {
  const before = myTeam().picks;
  const newCaptain = before.find((p) => p.position === 3).element;
  await page.click(`.pitch .pcard[data-id="${newCaptain}"]`);
  await page.click('.modal [data-action="cap"]');
  await page.click('[data-action="save"]');
  assert.match(await toastText(), /Team saved/);
  await dismissToasts();
  assert.equal(myTeam().picks.find((p) => p.is_captain).element, newCaptain);
  assert.ok(nativeCalls.some((c) => c.startsWith('POST fantasy.premierleague.com/api/my-team/')));
});

test('android: making a transfer', { skip }, async () => {
  await page.click('[data-view="transfers"]');
  const out = myTeam().picks.find((p) => p.element_type === 4);
  await page.click(`.squad-panel .pcard[data-id="${out.element}"]`);
  const target = await page.$eval('.market-list .mrow:not(.is-blocked):not(.is-owned) [data-pick]', (b) => Number(b.dataset.pick));
  await page.click(`.market-list [data-pick="${target}"]`);
  await dismissToasts();
  await page.click('[data-action="confirm"]');
  await page.click('.modal [data-action="ok"]');
  assert.match(await toastText(), /1 transfer made/);
  await dismissToasts();
  assert.ok(myTeam().picks.some((p) => p.element === target));
});

test('android: the back button closes things before leaving the app', { skip }, async () => {
  const anyCard = await page.$eval('.squad-panel .pcard', (c) => c.dataset.id);
  await page.click(`.squad-panel .pcard[data-id="${anyCard}"]`);
  assert.equal(await page.evaluate(() => window.fplmBack()), true, 'cancels the player being sold');
  await page.click('.market-list [data-info]');
  await page.waitForSelector('.modal');
  assert.equal(await page.evaluate(() => window.fplmBack()), true, 'closes the dialog');
  assert.equal(await page.$('.modal'), null);
  assert.equal(await page.evaluate(() => window.fplmBack()), true, 'goes back to Pick Team');
  await page.waitForSelector('.view-team');
  assert.equal(await page.evaluate(() => window.fplmBack()), false, 'lets Android close the app');
});

test('android: the login survives restarting the app, and renews itself when it expires', { skip }, async () => {
  const session = JSON.parse(storedSession);
  session.expires_at = Math.floor(Date.now() / 1000) - 10;
  storedSession = JSON.stringify(session);
  const refreshesBefore = mock.mock.state.log.filter((l) => l.type === 'refresh').length;
  await page.reload();
  await page.waitForSelector('.view-team .pcard');
  assert.equal(mock.mock.state.log.filter((l) => l.type === 'refresh').length, refreshesBefore + 1);
  const renewed = JSON.parse(storedSession);
  assert.ok(renewed.expires_at > Date.now() / 1000);
  assert.notEqual(renewed.refresh_token, session.refresh_token, 'new refresh token saved');
});

test('android: a login that finished while Android restarted the app is picked up', { skip }, async () => {
  // Log out first.
  await page.click('[data-action="account"]');
  await page.click('.modal [data-action="disconnect"]');
  await page.waitForSelector('.connect');
  assert.equal(storedSession, null);
  assert.equal(await page.evaluate(() => window.__cleared), 1, 'clears the login page cookies on logout');

  // The app saved its PKCE secrets, opened the login page, and was restarted.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('base64url');
  const authorize = new URL(`${mock.url}/as/authorize`);
  Object.entries({ client_id: 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030', redirect_uri: 'https://fantasy.premierleague.com/', response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256' })
    .forEach(([k, v]) => authorize.searchParams.set(k, v));
  const back = (await fetch(authorize, { redirect: 'manual' })).headers.get('location');
  const pending = { authority: `${mock.url}/as`, clientId: 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030', verifier, state, startedAt: Date.now() };
  await page.evaluate(({ pending, back }) => {
    localStorage.setItem('fplm.pendingLogin', JSON.stringify(pending));
    sessionStorage.setItem('restartResult', JSON.stringify({ url: back }));
  }, { pending, back });
  await page.addInitScript(() => {
    const r = sessionStorage.getItem('restartResult');
    if (r) { window.__loginResult = r; sessionStorage.removeItem('restartResult'); }
  });
  await page.reload();
  await page.waitForSelector('.view-team .pcard');
  assert.equal(JSON.parse(storedSession).entry, mock.mock.entryId);
});

test('android: the "log in via the FPL website" fallback', { skip }, async () => {
  await page.click('[data-action="account"]');
  await page.click('.modal [data-action="disconnect"]');
  await page.waitForSelector('.connect');
  await page.click('.connect details summary');
  await page.click('[data-action="site-login"]');
  await page.waitForSelector('.view-team .pcard');
  assert.ok(nativeCalls.includes('login:site'));
});

test('android: no errors in the console', { skip }, () => {
  assert.deepEqual(problems, []);
});

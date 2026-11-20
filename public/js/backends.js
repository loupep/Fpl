// Where the app's FPL requests go.
//  - ServerBackend: the desktop version, through the local Node server.
//  - NativeBackend: the Android app. Requests go straight to FPL through the
//    app's native layer (window.FplNative plus the /__native/ routes the app
//    serves), and the login screen is FPL's own, shown inside the app.

import { FplClient, FplError, FPL_BASE, LOGIN_REDIRECT_URI, startPkceLogin, finishPkceLogin } from './fpl-core.js';

// ------------------------------------------------------------------ desktop

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or not JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (HTTP ${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export class ServerBackend {
  native = false;
  getSession() { return call('GET', '/api/session'); }
  connect(input) { return call('POST', '/api/session', { input }); }
  disconnect() { return call('DELETE', '/api/session'); }
  demoLogin() { return call('GET', '/api/demo-login'); }
  fpl(path) { return call('GET', `/api/fpl/${path}`); }
  saveLineup(entry, payload) { return call('POST', `/api/fpl/my-team/${entry}/`, payload); }
  makeTransfers(payload) { return call('POST', '/api/fpl/transfers/', payload); }
  async resumeLogin() { return null; }
}

// ------------------------------------------------------------------ Android

const NATIVE = '/__native';
const PENDING_LOGIN = 'fplm.pendingLogin';

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Sends a request to an FPL host through the app. Request bodies travel in a
// header because Android doesn't pass request bodies to the app's handler.
export function nativeFetch(url, init = {}) {
  const u = new URL(url);
  const headers = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    if (!/^(user-agent|referer|origin)$/i.test(k)) headers[k] = v;
  }
  if (init.body != null && init.body !== '') headers['X-Fplm-Body'] = toBase64(String(init.body));
  return fetch(`${NATIVE}/fpl/${u.host}${u.pathname}${u.search}`, {
    method: init.method ?? 'GET',
    headers,
    signal: init.signal,
    cache: 'no-store',
  });
}

const nativeStore = {
  async load() {
    const res = await fetch(`${NATIVE}/session`, { cache: 'no-store' });
    if (res.status !== 200) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
  async save(session) {
    await fetch(`${NATIVE}/session`, {
      method: 'POST',
      headers: session ? { 'X-Fplm-Body': toBase64(JSON.stringify(session)) } : {},
    });
  },
};

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export class NativeBackend {
  native = true;

  constructor(bridge) {
    this.bridge = bridge;
    this.client = new FplClient({ base: FPL_BASE, store: nativeStore, fetchImpl: nativeFetch });
    this.ready = this.client.loadSession();
    this.waiting = null;
    this.unclaimed = null;
    // The app calls this when its login screen closes.
    window.fplmNativeLoginDone = () => this.takeResult();
  }

  info(extra = {}) { return { ...this.client.sessionInfo(), native: true, demo: false, ...extra }; }
  async getSession() { await this.ready; return this.info(); }
  async connect(input) { await this.ready; await this.client.connect(input); return this.info(); }

  async disconnect() {
    await this.client.disconnect();
    try { this.bridge.clearLoginData(); } catch { /* older app */ }
    return this.info();
  }

  fpl(path) { return this.ready.then(() => this.client.appGet(path)); }
  saveLineup(entry, payload) { return this.client.appPost(`my-team/${entry}/`, payload); }
  makeTransfers(payload) { return this.client.appPost('transfers/', payload); }

  takeResult() {
    let raw = null;
    try { raw = this.bridge.takeLoginResult(); } catch { /* none */ }
    if (!raw) return;
    const result = JSON.parse(raw);
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(result);
    } else {
      this.unclaimed = result;
    }
  }

  open(request) {
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.bridge.startLogin(JSON.stringify(request));
    });
  }

  // FPL's sign-in page inside the app, using the same sign-in as the website.
  async login() {
    const { url, pending } = await startPkceLogin();
    storage.set(PENDING_LOGIN, JSON.stringify(pending));
    return this.finish(await this.open({ mode: 'oauth', url, redirect: LOGIN_REDIRECT_URI }));
  }

  // Fallback: log in on the FPL website inside the app and pick up its login.
  async loginViaWebsite() {
    return this.finish(await this.open({ mode: 'site', url: `${FPL_BASE}/` }));
  }

  // If Android restarted the app while the login screen was open, the result
  // arrives at start-up instead.
  async resumeLogin() {
    await this.ready;
    this.takeResult();
    if (!this.unclaimed) return null;
    const result = this.unclaimed;
    this.unclaimed = null;
    return this.finish(result);
  }

  async finish(result) {
    if (!result || result.cancelled) return null;
    if (result.error) throw new FplError(result.error, 400);
    let login;
    if (result.url) {
      const pending = JSON.parse(storage.get(PENDING_LOGIN) || 'null');
      storage.remove(PENDING_LOGIN);
      login = await finishPkceLogin(this.client, pending, result.url);
    } else if (result.login) {
      login = result.login;
    } else {
      throw new FplError("The login didn't finish. Try again.", 400);
    }
    return this.connect(JSON.stringify(login));
  }
}

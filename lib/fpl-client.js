// Talks to the FPL API on behalf of the browser. It keeps the login on this
// machine, attaches it to requests, and refreshes it when it expires.

import { readFile, writeFile, rm, chmod } from 'node:fs/promises';

export const FPL_BASE = 'https://fantasy.premierleague.com';
// Used only when a pasted login doesn't say which identity provider issued it.
export const DEFAULT_AUTHORITY = 'https://account.premierleague.com/as';
export const DEFAULT_CLIENT_ID = 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_SKEW_S = 60;

export class FplError extends Error {
  constructor(message, status = 500, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

const looksLikeJwt = (s) => /^[\w-]+\.[\w-]+\.[\w-]*$/.test(s);

// Accepts any of:
//  - the JSON the README's console snippet copies ({authority, client_id, access_token, refresh_token, expires_at})
//  - the raw oidc.user:* value from the FPL site's localStorage
//  - a bare access token, with or without "Bearer "
//  - a team ID (digits only), for view-only planning without logging in
export function parseLoginInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new FplError('Paste your FPL login details or your team ID first.', 400);
  if (/^\d{1,10}$/.test(text)) return { kind: 'public', entry: Number(text) };

  const bare = text.replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '');
  if (looksLikeJwt(bare)) {
    return { kind: 'auth', access_token: bare, refresh_token: null, expires_at: decodeJwtExp(bare), authority: DEFAULT_AUTHORITY, client_id: DEFAULT_CLIENT_ID };
  }

  let obj;
  try {
    obj = JSON.parse(text);
    if (typeof obj === 'string') obj = JSON.parse(obj);
  } catch {
    throw new FplError("That doesn't look like FPL login details. Paste the text the console snippet copied, an access token, or your team ID.", 400);
  }
  const access = typeof obj?.access_token === 'string' ? obj.access_token : null;
  const refresh = typeof obj?.refresh_token === 'string' ? obj.refresh_token : null;
  if (!access && !refresh) throw new FplError('The pasted text has no access_token or refresh_token in it.', 400);
  const expiresAt = Number.isFinite(obj.expires_at) ? obj.expires_at : decodeJwtExp(access);
  return {
    kind: 'auth',
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    authority: typeof obj.authority === 'string' && /^https?:\/\//.test(obj.authority) ? obj.authority.replace(/\/$/, '') : DEFAULT_AUTHORITY,
    client_id: typeof obj.client_id === 'string' && obj.client_id ? obj.client_id : DEFAULT_CLIENT_ID,
  };
}

// Pulls readable messages out of FPL's error bodies, whatever shape they take.
export function errorStrings(data, limit = 4) {
  const out = [];
  const walk = (v) => {
    if (out.length >= limit || v == null) return;
    if (typeof v === 'string') { if (v.trim()) out.push(v.trim()); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

function describeFailure(status, data, text) {
  const details = errorStrings(data);
  if (status === 401 || status === 403) {
    return details.length && !/credentials were not provided|not enough segments|authentication/i.test(details.join(' '))
      ? details.join(' ')
      : 'FPL rejected your login. It has probably expired, so connect again from the account menu.';
  }
  if (details.length) return details.join(' ');
  if (status === 404) return 'FPL could not find that.';
  if (status === 429) return 'FPL is limiting requests right now. Wait a minute and try again.';
  if (status === 503 && /updat/i.test(text ?? '')) return 'The FPL game is being updated. Try again shortly.';
  if (status >= 500) return `FPL is having problems right now (HTTP ${status}). Try again shortly.`;
  return `FPL returned HTTP ${status}.`;
}

export class FplClient {
  constructor({ base = FPL_BASE, sessionFile = null, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.base = base.replace(/\/$/, '');
    this.sessionFile = sessionFile;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.session = null;
    this.cache = new Map();
    this.refreshing = null;
    this.lastRefresh = 0;
    this.tokenEndpointCache = null;
  }

  async loadSession() {
    if (!this.sessionFile) return;
    try {
      this.session = JSON.parse(await readFile(this.sessionFile, 'utf8'));
    } catch {
      this.session = null;
    }
  }

  async saveSession() {
    if (!this.sessionFile) return;
    if (!this.session) {
      await rm(this.sessionFile, { force: true });
      return;
    }
    await writeFile(this.sessionFile, JSON.stringify(this.session, null, 2), { mode: 0o600 });
    await chmod(this.sessionFile, 0o600).catch(() => {});
  }

  setSession(session) {
    this.session = session;
    this.cache.clear();
  }

  sessionInfo() {
    const s = this.session;
    if (!s) return { connected: false };
    return {
      connected: true,
      mode: s.kind,
      entry: s.entry ?? null,
      name: s.name ?? null,
      canRefresh: Boolean(s.refresh_token),
      expiresAt: s.expires_at ?? null,
    };
  }

  async connect(raw) {
    const parsed = parseLoginInput(raw);
    const previous = this.session;
    if (parsed.kind === 'public') {
      const entry = await this.request('GET', `/api/entry/${parsed.entry}/`, { auth: false });
      this.setSession({ kind: 'public', entry: parsed.entry, name: entry?.name ?? null });
    } else {
      this.setSession(parsed);
      try {
        const me = await this.request('GET', '/api/me/');
        const player = me?.player;
        if (!player?.entry) {
          throw new FplError("FPL didn't accept that login, or the account has no team yet. Copy your login details again and paste them here.", 401);
        }
        this.session.entry = player.entry;
        this.session.name = [player.first_name, player.last_name].filter(Boolean).join(' ') || null;
      } catch (err) {
        this.session = previous;
        throw err;
      }
    }
    await this.saveSession();
    return this.sessionInfo();
  }

  async disconnect() {
    this.setSession(null);
    await this.saveSession();
  }

  async fetch(url, init = {}) {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out' : (err?.cause?.code || err?.message || 'failed');
      throw new FplError(`Couldn't reach FPL (${reason}). Check your internet connection.`, 502);
    }
  }

  async accessToken() {
    const s = this.session;
    if (!s || s.kind !== 'auth') return null;
    const nowS = this.now() / 1000;
    const fresh = s.access_token && (!s.expires_at || s.expires_at - REFRESH_SKEW_S > nowS);
    if (fresh) return s.access_token;
    if (s.refresh_token) {
      await this.refresh();
      return this.session?.access_token ?? null;
    }
    return s.access_token;
  }

  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async tokenEndpoint(authority) {
    if (this.tokenEndpointCache?.authority === authority) return this.tokenEndpointCache.url;
    let url = `${authority}/token`;
    try {
      const res = await this.fetch(`${authority}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const doc = await res.json();
        if (typeof doc.token_endpoint === 'string') url = doc.token_endpoint;
      }
    } catch {
      // fall back to the conventional path
    }
    this.tokenEndpointCache = { authority, url };
    return url;
  }

  async doRefresh() {
    const s = this.session;
    if (!s?.refresh_token) throw new FplError('Your FPL login has expired. Connect again from the account menu.', 401);
    const endpoint = await this.tokenEndpoint(s.authority || DEFAULT_AUTHORITY);
    const res = await this.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id || DEFAULT_CLIENT_ID }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || typeof data?.access_token !== 'string') {
      const why = data?.error_description || data?.error || `HTTP ${res.status}`;
      throw new FplError(`Couldn't renew your FPL login (${why}). Connect again from the account menu.`, 401, data);
    }
    s.access_token = data.access_token;
    if (typeof data.refresh_token === 'string') s.refresh_token = data.refresh_token; // tokens rotate on every use
    const expiresIn = Number(data.expires_in);
    s.expires_at = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(this.now() / 1000) + expiresIn : decodeJwtExp(data.access_token);
    this.lastRefresh = this.now();
    await this.saveSession();
  }

  async request(method, path, { body, auth = true, cacheMs = 0 } = {}) {
    const cacheKey = method === 'GET' && cacheMs ? path : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.until > this.now()) return hit.data;
    }
    const send = async () => {
      const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT, Referer: `${this.base}/` };
      if (auth) {
        const token = await this.accessToken();
        if (token) headers['X-Api-Authorization'] = `Bearer ${token}`;
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers.Origin = this.base;
      }
      return this.fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', // never forward the login header to another host
      });
    };

    let res = await send();
    const canRetry = auth && this.session?.kind === 'auth' && this.session.refresh_token && this.now() - this.lastRefresh > 60_000;
    if ((res.status === 401 || res.status === 403) && canRetry) {
      await this.refresh();
      res = await send();
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status >= 300 && res.status < 400) {
      throw new FplError('FPL redirected the request, which usually means the login was not accepted. Connect again from the account menu.', 401);
    }
    if (!res.ok) throw new FplError(describeFailure(res.status, data, text), res.status, data);
    if (text && data === null) throw new FplError('FPL sent back something unexpected. Try again shortly.', 502);
    if (cacheKey) this.cache.set(cacheKey, { data, until: this.now() + cacheMs });
    return data;
  }
}

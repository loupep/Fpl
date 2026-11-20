// FPL API client shared by the desktop server (Node) and the Android app
// (WebView). It keeps the login, attaches it to requests, renews it when it
// expires and turns FPL's errors into readable messages. Platform specifics
// (how to send HTTP requests, where to keep the login) are passed in.

export const FPL_BASE = 'https://fantasy.premierleague.com';
// The FPL website's own login settings (from its public site code).
export const DEFAULT_AUTHORITY = 'https://account.premierleague.com/as';
export const DEFAULT_CLIENT_ID = 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';
export const LOGIN_REDIRECT_URI = 'https://fantasy.premierleague.com/';
export const LOGIN_SCOPE = 'openid profile email offline_access p1:update:user consent interest';

const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_SKEW_S = 60;
const LONG_CACHE_MS = 5 * 60_000;

// Which FPL endpoints the app uses, which need a login and how long public
// data may be cached.
const CACHE_RULES = [
  [/^\/api\/bootstrap-static\/$/, LONG_CACHE_MS],
  [/^\/api\/fixtures\/$/, LONG_CACHE_MS],
  [/^\/api\/element-summary\/\d+\/$/, LONG_CACHE_MS],
  [/^\/api\/event\/\d+\/live\/$/, 30_000],
];
const AUTH_GET = [/^\/api\/me\/$/, /^\/api\/my-team\/\d+\/$/, /^\/api\/entry\/\d+\/transfers-latest\/$/];
const ALLOWED_POST = [/^\/api\/my-team\/\d+\/$/, /^\/api\/transfers\/$/];

export function upstreamPath(appPath) {
  const upstream = `/api/${String(appPath).replace(/^\/+/, '')}`;
  const [path, query = ''] = upstream.split('?');
  if (!/^\/api\/[a-z0-9\-/]+\/$/i.test(path) || path.includes('//')) return null;
  return { path, query: /^[\w=&%-]{0,100}$/.test(query) && query ? `?${query}` : '' };
}
export const getOptions = (path) => ({
  auth: AUTH_GET.some((re) => re.test(path)),
  cacheMs: CACHE_RULES.find(([re]) => re.test(path))?.[1] ?? 0,
});
export const postAllowed = (path) => ALLOWED_POST.some((re) => re.test(path));

export class FplError extends Error {
  constructor(message, status = 500, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function base64UrlDecode(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(base64UrlDecode(String(token).split('.')[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

const looksLikeJwt = (s) => /^[\w-]+\.[\w-]+\.[\w-]*$/.test(s);

// Accepts any of:
//  - the JSON the console snippet or in-app login produces ({authority, client_id, access_token, refresh_token, expires_at})
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

// FPL reports validation problems as codes, e.g.
// {"transfers":[{"non_field_errors":[{"code":"transfer_cap_exceeded"}]}]}.
const ERROR_CODES = {
  transfer_cap_exceeded: 'You can make at most 20 transfers in one gameweek.',
  transfer_element_in_price_mismatch: "A player's price has changed. Reload the app and try again.",
  transfer_element_out_price_mismatch: "A player's selling price has changed. Reload the app and try again.",
};
const humanize = (code) => {
  const s = String(code).replace(/_/g, ' ').trim();
  return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : '';
};

export function errorStrings(data, limit = 4) {
  const out = [];
  const add = (s) => { if (s && !out.includes(s) && out.length < limit) out.push(s); };
  const walk = (v) => {
    if (out.length >= limit || v == null) return;
    if (typeof v === 'string') { add(v.trim()); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      if (typeof v.code === 'string') {
        add(ERROR_CODES[v.code] ?? (typeof v.message === 'string' && v.message.trim() ? v.message.trim() : humanize(v.code)));
        return;
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(data);
  return out;
}

function describeFailure(status, data, text) {
  const details = errorStrings(data);
  if (status === 401 || status === 403) {
    return details.length && !/credentials were not provided|not enough segments|authentication/i.test(details.join(' '))
      ? details.join(' ')
      : 'FPL rejected your login. It has probably expired, so log in again from the account menu.';
  }
  if (details.length) return details.join(' ');
  if (status === 404) return 'FPL could not find that.';
  if (status === 429) return 'FPL is limiting requests right now. Wait a minute and try again.';
  if (status === 503 && /updat/i.test(text ?? '')) return 'The FPL game is being updated. Try again shortly.';
  if (status >= 500) return `FPL is having problems right now (HTTP ${status}). Try again shortly.`;
  return `FPL returned HTTP ${status}.`;
}

export const memoryStore = () => {
  let value = null;
  return { async load() { return value; }, async save(s) { value = s ? JSON.parse(JSON.stringify(s)) : null; } };
};

export class FplClient {
  // store: { load(): Promise<session|null>, save(session|null): Promise }
  // headers: extra headers for every request; postHeaders: extra for POSTs.
  constructor({ base = FPL_BASE, store = memoryStore(), fetchImpl = globalThis.fetch.bind(globalThis), now = () => Date.now(), headers = {}, postHeaders = {} } = {}) {
    this.base = base.replace(/\/$/, '');
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.headers = headers;
    this.postHeaders = postHeaders;
    this.session = null;
    this.cache = new Map();
    this.refreshing = null;
    this.lastRefresh = 0;
    this.tokenEndpointCache = null;
  }

  async loadSession() {
    try {
      this.session = (await this.store.load()) ?? null;
    } catch {
      this.session = null;
    }
  }

  async saveSession() {
    await this.store.save(this.session);
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
          throw new FplError("FPL didn't accept that login, or the account has no team yet. Log in again.", 401);
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
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
      return await this.fetchImpl(url, { ...init, signal });
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

  // Posts a form to the login service's token endpoint (renewal or first login).
  async tokenRequest(authority, form) {
    const endpoint = await this.tokenEndpoint(authority);
    const res = await this.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || typeof data?.access_token !== 'string') {
      const why = data?.error_description || data?.error || `HTTP ${res.status}`;
      throw new FplError(why, 401, data);
    }
    const expiresIn = Number(data.expires_in);
    return {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(this.now() / 1000) + expiresIn : decodeJwtExp(data.access_token),
    };
  }

  async doRefresh() {
    const s = this.session;
    if (!s?.refresh_token) throw new FplError('Your FPL login has expired. Log in again from the account menu.', 401);
    let tokens;
    try {
      tokens = await this.tokenRequest(s.authority || DEFAULT_AUTHORITY, { grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id || DEFAULT_CLIENT_ID });
    } catch (err) {
      throw new FplError(`Couldn't renew your FPL login (${err.message}). Log in again from the account menu.`, 401, err.data);
    }
    s.access_token = tokens.access_token;
    if (tokens.refresh_token) s.refresh_token = tokens.refresh_token; // tokens rotate on every use
    s.expires_at = tokens.expires_at;
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
      const headers = { Accept: 'application/json', ...this.headers };
      if (auth) {
        const token = await this.accessToken();
        if (token) headers['X-Api-Authorization'] = `Bearer ${token}`;
      }
      if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json' }, this.postHeaders);
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
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new FplError('FPL redirected the request, which usually means the login was not accepted. Log in again from the account menu.', 401);
    }
    if (!res.ok) throw new FplError(describeFailure(res.status, data, text), res.status, data);
    if (text && data === null) throw new FplError('FPL sent back something unexpected. Try again shortly.', 502);
    if (cacheKey) this.cache.set(cacheKey, { data, until: this.now() + cacheMs });
    return data;
  }

  // The app-facing operations, shared by the server and the Android app.
  async appGet(appPath) {
    const target = upstreamPath(appPath);
    if (!target) throw new FplError('Unsupported FPL path.', 400);
    const { auth, cacheMs } = getOptions(target.path);
    if (auth && this.session?.kind !== 'auth') throw new FplError('Log in to FPL to see this.', 401);
    return this.request('GET', target.path + target.query, { auth, cacheMs });
  }

  async appPost(appPath, body) {
    const target = upstreamPath(appPath);
    if (!target || !postAllowed(target.path)) throw new FplError('Method not allowed', 405);
    if (this.session?.kind !== 'auth') throw new FplError('Log in to FPL before saving changes.', 401);
    return (await this.request('POST', target.path, { body })) ?? { ok: true };
  }
}

// ------------------------------------------------------------ in-app login

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The standard OAuth "authorization code with PKCE" sign-in, using the same
// settings as the FPL website. Returns the URL to open and the secrets needed
// to finish once the login page sends the user back.
export async function startPkceLogin({ authority = DEFAULT_AUTHORITY, clientId = DEFAULT_CLIENT_ID } = {}) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = `${authority}/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: LOGIN_REDIRECT_URI,
    response_type: 'code',
    scope: LOGIN_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;
  return { url, pending: { authority, clientId, verifier, state, startedAt: Date.now() } };
}

// Turns the URL the login page redirected to into a login the client accepts.
export async function finishPkceLogin(client, pending, redirectedTo) {
  let params;
  try {
    params = new URL(redirectedTo).searchParams;
  } catch {
    throw new FplError('The login page sent back something unexpected. Try logging in again.', 400);
  }
  if (params.get('error')) throw new FplError(params.get('error_description') || `Login failed (${params.get('error')}).`, 401);
  if (!pending || params.get('state') !== pending.state) throw new FplError('That login took too long or was interrupted. Try again.', 400);
  const code = params.get('code');
  if (!code) throw new FplError('The login page did not finish signing you in. Try again.', 400);
  let tokens;
  try {
    tokens = await client.tokenRequest(pending.authority, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: LOGIN_REDIRECT_URI,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
  } catch (err) {
    throw new FplError(`Couldn't finish logging in (${err.message}). Try again.`, 401, err.data);
  }
  return { authority: pending.authority, client_id: pending.clientId, ...tokens };
}

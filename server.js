#!/usr/bin/env node
// Local server for FPL Manager. It serves the web app and forwards the app's
// requests to FPL with your login attached. It only listens on this computer.
//
//   node server.js          use your real FPL account
//   node server.js --demo   try the app against a built-in pretend league

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FplClient, FplError, FPL_BASE } from './lib/fpl-client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEMO = process.argv.includes('--demo') || process.env.FPL_DEMO === '1';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const LONG_CACHE_MS = 5 * 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Public data that changes slowly is cached briefly so the app stays quick.
const CACHE_RULES = [
  [/^\/api\/bootstrap-static\/$/, LONG_CACHE_MS],
  [/^\/api\/fixtures\/$/, LONG_CACHE_MS],
  [/^\/api\/element-summary\/\d+\/$/, LONG_CACHE_MS],
  [/^\/api\/event\/\d+\/live\/$/, 30_000],
];
const AUTH_GET = [/^\/api\/me\/$/, /^\/api\/my-team\/\d+\/$/, /^\/api\/entry\/\d+\/transfers-latest\/$/];
const ALLOWED_POST = [/^\/api\/my-team\/\d+\/$/, /^\/api\/transfers\/$/];

let client;
let demoInfo = null;

async function setup() {
  if (DEMO) {
    const { startMockFpl } = await import('./mock/mock-fpl.js');
    const mock = await startMockFpl({ port: 0 });
    client = new FplClient({ base: mock.url });
    client.setSession(mock.demoSession());
    demoInfo = mock;
  } else {
    client = new FplClient({ base: process.env.FPL_BASE ?? FPL_BASE, sessionFile: path.join(ROOT, '.fpl-session.json') });
    await client.loadSession();
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err instanceof FplError ? err.status : 500;
  if (!(err instanceof FplError)) console.error(err);
  send(res, status >= 400 && status < 600 ? status : 502, {
    error: err instanceof FplError ? err.message : 'Something went wrong in the local server.',
    details: err instanceof FplError ? err.data : null,
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new FplError('Request too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new FplError('Request body must be JSON.', 400);
  }
}

// Only pages served from this server may use it: blocks other websites from
// reaching your FPL login through your browser.
function trustedRequest(req) {
  const host = req.headers.host ?? '';
  const okHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  if (!okHost) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return (req.headers['content-type'] ?? '').startsWith('application/json') || req.method === 'DELETE';
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  try {
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, 'Not found');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found');
  }
}

async function handleApi(req, res, url) {
  const { pathname, search } = url;

  if (pathname === '/api/session') {
    if (req.method === 'GET') return send(res, 200, { ...client.sessionInfo(), demo: DEMO });
    if (req.method === 'POST') {
      const { input } = await readJson(req);
      const info = await client.connect(input);
      return send(res, 200, { ...info, demo: DEMO });
    }
    if (req.method === 'DELETE') {
      await client.disconnect();
      return send(res, 200, { connected: false, demo: DEMO });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (pathname === '/api/demo-login' && DEMO && req.method === 'GET') {
    return send(res, 200, { input: JSON.stringify(demoInfo.loginBlob()) });
  }

  if (pathname.startsWith('/api/fpl/')) {
    const upstream = `/api/${pathname.slice('/api/fpl/'.length)}`;
    if (!/^\/api\/[a-z0-9\-/]+\/$/i.test(upstream) || upstream.includes('//')) {
      return send(res, 400, { error: 'Unsupported FPL path.' });
    }
    const query = /^\?[\w=&%-]{0,100}$/.test(search) ? search : '';
    if (req.method === 'GET') {
      const cacheMs = CACHE_RULES.find(([re]) => re.test(upstream))?.[1] ?? 0;
      const auth = AUTH_GET.some((re) => re.test(upstream));
      if (auth && client.session?.kind !== 'auth') return send(res, 401, { error: 'Log in to FPL to see this.' });
      const data = await client.request('GET', upstream + query, { auth, cacheMs });
      return send(res, 200, data);
    }
    if (req.method === 'POST' && ALLOWED_POST.some((re) => re.test(upstream))) {
      if (client.session?.kind !== 'auth') return send(res, 401, { error: 'Log in to FPL before saving changes.' });
      const body = await readJson(req);
      const data = await client.request('POST', upstream, { body });
      return send(res, 200, data ?? { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  return send(res, 404, { error: 'Not found' });
}

await setup();

const server = http.createServer(async (req, res) => {
  try {
    if (!trustedRequest(req)) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    sendError(res, err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start on another port with: PORT=3001 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const where = `http://localhost:${server.address().port}`;
  console.log(`\nFPL Manager is running${DEMO ? ' in DEMO mode (pretend league, nothing touches FPL)' : ''}.`);
  console.log(`Open ${where} in your browser. Press Ctrl+C to stop.\n`);
});

const shutdown = () => {
  server.close();
  demoInfo?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

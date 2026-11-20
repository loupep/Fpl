import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FplClient, parseLoginInput, decodeJwtExp, errorStrings, DEFAULT_AUTHORITY } from '../lib/fpl-client.js';
import { startMockFpl } from '../mock/mock-fpl.js';

const mock = await startMockFpl();
after(() => mock.close());

const jwt = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('parseLoginInput understands every supported format', () => {
  assert.deepEqual(parseLoginInput(' 1234567 '), { kind: 'public', entry: 1234567 });

  const token = jwt({ exp: 2_000_000_000 });
  const bare = parseLoginInput(`Bearer ${token}`);
  assert.equal(bare.kind, 'auth');
  assert.equal(bare.access_token, token);
  assert.equal(bare.expires_at, 2_000_000_000);
  assert.equal(bare.authority, DEFAULT_AUTHORITY);

  const blob = { authority: 'https://login.example/as/', client_id: 'abc', access_token: token, refresh_token: 'r1', expires_at: 123 };
  const parsed = parseLoginInput(JSON.stringify(blob));
  assert.equal(parsed.authority, 'https://login.example/as');
  assert.equal(parsed.client_id, 'abc');
  assert.equal(parsed.refresh_token, 'r1');
  assert.equal(parsed.expires_at, 123);

  // Console output pasted with surrounding quotes is a JSON string of JSON.
  assert.equal(parseLoginInput(JSON.stringify(JSON.stringify(blob))).refresh_token, 'r1');
  // The raw oidc-client value has no authority or client id.
  assert.equal(parseLoginInput(JSON.stringify({ access_token: token, refresh_token: 'r2', profile: {} })).client_id.length > 0, true);

  assert.throws(() => parseLoginInput(''), /Paste/);
  assert.throws(() => parseLoginInput('hello'), /doesn't look like/);
  assert.throws(() => parseLoginInput('{"foo":1}'), /no access_token/);
});

test('decodeJwtExp and errorStrings', () => {
  assert.equal(decodeJwtExp(jwt({ exp: 5 })), 5);
  assert.equal(decodeJwtExp('nope'), null);
  assert.deepEqual(errorStrings({ errors: ['A'], detail: { x: 'B' } }), ['A', 'B']);
  assert.deepEqual(errorStrings(null), []);
});

test('connecting with an expired token refreshes it, saves the rotated token and loads my-team', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fplm-'));
  const file = path.join(dir, 'session.json');
  const client = new FplClient({ base: mock.url, sessionFile: file });
  const blob = mock.loginBlob();
  const info = await client.connect(JSON.stringify(blob));
  assert.equal(info.connected, true);
  assert.equal(info.mode, 'auth');
  assert.equal(info.entry, mock.mock.entryId);
  assert.notEqual(client.session.refresh_token, blob.refresh_token, 'refresh token rotated');
  assert.ok(client.session.expires_at > Date.now() / 1000);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.refresh_token, client.session.refresh_token);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

  const myTeam = await client.request('GET', `/api/my-team/${info.entry}/`);
  assert.equal(myTeam.picks.length, 15);

  // A fresh client picks the session up from disk.
  const again = new FplClient({ base: mock.url, sessionFile: file });
  await again.loadSession();
  assert.equal(again.sessionInfo().entry, info.entry);
  await again.disconnect();
  await assert.rejects(stat(file));
});

test('a used refresh token is rejected with a helpful message and the old session is kept', async () => {
  const client = new FplClient({ base: mock.url });
  const blob = mock.loginBlob();
  await client.connect(JSON.stringify(blob)); // uses and rotates blob.refresh_token
  const other = new FplClient({ base: mock.url });
  await assert.rejects(other.connect(JSON.stringify(blob)), (err) => err.status === 401 && /renew your FPL login/.test(err.message));
  assert.equal(other.sessionInfo().connected, false);
});

test('a token FPL does not recognise is rejected', async () => {
  const client = new FplClient({ base: mock.url });
  await assert.rejects(client.connect(jwt({ exp: 9_999_999_999 })), /didn't accept that login/);
});

test('view-only mode uses the public endpoints', async () => {
  const client = new FplClient({ base: mock.url });
  const info = await client.connect(String(mock.mock.entryId));
  assert.equal(info.mode, 'public');
  assert.equal(info.name, 'Demo Dynamos');
  await assert.rejects(client.connect('999'), (err) => err.status === 404);
});

test('FPL validation errors come back as readable messages', async () => {
  const client = new FplClient({ base: mock.url });
  client.setSession(mock.demoSession());
  await assert.rejects(
    client.request('POST', '/api/transfers/', { body: { entry: mock.mock.entryId, event: 1, transfers: [] } }),
    (err) => err.status === 400 && /Transfers are for gameweek/.test(err.message),
  );
});

// Node wrapper around the shared FPL client: keeps the login in a file next to
// the app and sends browser-like headers.

import { readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { FplClient as CoreClient } from '../public/js/fpl-core.js';

export {
  FplError, parseLoginInput, decodeJwtExp, errorStrings, upstreamPath, getOptions, postAllowed,
  FPL_BASE, DEFAULT_AUTHORITY, DEFAULT_CLIENT_ID, memoryStore,
} from '../public/js/fpl-core.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export function fileStore(file) {
  return {
    async load() {
      try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
    },
    async save(session) {
      if (!session) { await rm(file, { force: true }); return; }
      await writeFile(file, JSON.stringify(session, null, 2), { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
    },
  };
}

export class FplClient extends CoreClient {
  constructor({ base, sessionFile = null, store, ...rest } = {}) {
    const origin = (base ?? 'https://fantasy.premierleague.com').replace(/\/$/, '');
    super({
      base: origin,
      store: store ?? (sessionFile ? fileStore(sessionFile) : undefined),
      headers: { 'User-Agent': USER_AGENT, Referer: `${origin}/` },
      postHeaders: { Origin: origin },
      ...rest,
    });
  }
}

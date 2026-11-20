// Calls to the local server. Every FPL request goes through it so the login
// never has to live in the browser.

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

export const getSession = () => call('GET', '/api/session');
export const connect = (input) => call('POST', '/api/session', { input });
export const disconnect = () => call('DELETE', '/api/session');
export const demoLogin = () => call('GET', '/api/demo-login');
export const fpl = (path) => call('GET', `/api/fpl/${path}`);
export const saveLineup = (entry, payload) => call('POST', `/api/fpl/my-team/${entry}/`, payload);
export const makeTransfers = (payload) => call('POST', '/api/fpl/transfers/', payload);

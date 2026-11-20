// First-run screen. In the Android app: log in on FPL's own login page inside
// the app. On a computer: copy the login from the FPL website. Either way you
// can instead enter a team ID to look around and plan.

import * as api from '../api.js';
import { esc, toast, busy } from '../ui.js';

// Runs in the browser console on fantasy.premierleague.com. It copies the
// site's own login (kept in browser storage) so this app can act for you.
export const SNIPPET = `(() => {
  const stores = [localStorage, sessionStorage];
  for (const s of stores) {
    const k = Object.keys(s).find((k) => k.startsWith('oidc.user:'));
    if (!k) continue;
    const v = JSON.parse(s.getItem(k));
    const p = k.split(':');
    copy(JSON.stringify({ authority: p.slice(1, -1).join(':'), client_id: p.at(-1), access_token: v.access_token, refresh_token: v.refresh_token, expires_at: v.expires_at }));
    return 'Copied your FPL login. Paste it into FPL Manager.';
  }
  return 'No FPL login found. Log in on this tab first, then run this again.';
})()`;

function nativeLoginCard() {
  return `
        <div class="card connect-card">
          <h2>Log in <span class="tag">to save changes</span></h2>
          <p class="muted">Sign in with your Fantasy Premier League email and password on FPL's own login page. The app carries on by itself once you're in.</p>
          <button type="button" class="btn btn-primary btn-big" data-action="native-login">Log in with FPL</button>
          <details class="small muted">
            <summary>Having trouble logging in?</summary>
            <p>If you normally sign in with Google or Facebook, that won't work inside other apps. Use <em>Forgot password</em> on the login page to give your account a password, then log in with your email and that password.</p>
            <p>If the login page doesn't bring you back here, try logging in through the FPL website instead:</p>
            <p><button type="button" class="btn btn-small" data-action="site-login">Log in via the FPL website</button></p>
            <p>Your login is stored only on this phone and renews itself for about a month.</p>
          </details>
        </div>`;
}

function desktopLoginCard(demo) {
  return `
        <form class="card connect-card" data-form="login">
          <h2>Log in <span class="tag">to save changes</span></h2>
          <ol class="steps">
            <li>Open <a href="https://fantasy.premierleague.com/my-team" target="_blank" rel="noopener">fantasy.premierleague.com</a> and log in.</li>
            <li>Open the browser console on that tab: <kbd>F12</kbd> on Windows, <kbd>⌥ ⌘ J</kbd> on a Mac (Chrome), then the <em>Console</em> tab.</li>
            <li>Copy this snippet, paste it into the console and press <kbd>Enter</kbd>. Chrome may ask you to type <code>allow pasting</code> first.
              <div class="snippet"><pre><code>${esc(SNIPPET)}</code></pre><button type="button" class="btn btn-small" data-action="copy">Copy snippet</button></div>
            </li>
            <li>Paste what it copied here:</li>
          </ol>
          <label class="sr-only" for="login-input">FPL login details</label>
          <textarea id="login-input" name="input" rows="3" placeholder='{"authority": "…", "access_token": "…", …}' spellcheck="false" autocomplete="off"></textarea>
          <div class="row-gap">
            <button class="btn btn-primary" type="submit">Connect</button>
            ${demo ? '<button type="button" class="btn" data-action="demo">Fill in demo login</button>' : ''}
          </div>
          <details class="small muted">
            <summary>What does this do, and is it safe?</summary>
            <p>FPL has no official way for apps to log in, so this borrows the login your browser already has. The snippet only reads it and copies it to your clipboard. FPL Manager saves it in <code>.fpl-session.json</code> next to the app and only sends it to FPL.</p>
            <p>The login renews itself for about 30 days. Renewing can log you out of the FPL website in that browser; just log in there again if it does.</p>
            <p>You can also paste just an access token (the value after <code>Bearer</code> in the <code>x-api-authorization</code> header of any FPL request in the Network tab). Those last a few hours.</p>
          </details>
        </form>`;
}

export function render(root, app, { onConnected }) {
  const demo = app.session?.demo;
  const native = api.isNative;
  root.innerHTML = `
    <section class="connect">
      <div class="connect-intro">
        <h1>Connect your FPL team</h1>
        <p class="muted">Pick your team, set your captain and make transfers from here. Your login stays on this ${native ? 'phone' : 'computer'} and is only ever sent to FPL.</p>
        ${demo ? '<p class="note">Demo mode: use the <strong>Fill in demo login</strong> button. Nothing here touches the real FPL.</p>' : ''}
      </div>

      <div class="connect-grid">
        ${native ? nativeLoginCard() : desktopLoginCard(demo)}

        <form class="card connect-card" data-form="public">
          <h2>Just look and plan <span class="tag tag-muted">no login</span></h2>
          <p class="muted">Enter your team ID to see your squad, plan transfers and check fixtures. You won't be able to save changes.</p>
          <p class="small muted">Find it on the FPL website: go to <em>Points</em> and copy the number in the address, e.g. <code>/entry/<strong>1234567</strong>/event/12</code>.</p>
          <label for="team-id">Team ID</label>
          <input id="team-id" name="entry" inputmode="numeric" pattern="[0-9]*" placeholder="1234567" autocomplete="off">
          <div class="row-gap"><button class="btn" type="submit">View team</button></div>
        </form>
      </div>
    </section>`;

  const connect = async (input, button) => {
    busy(button, true);
    try {
      const session = await api.connect(input);
      toast(session.mode === 'auth' ? `Connected${session.name ? ` as ${session.name}` : ''}.` : 'Team found. You are in view-only mode.', 'success');
      await onConnected(session);
    } catch (err) {
      toast(err.message, 'error', 7000);
    } finally {
      busy(button, false);
    }
  };

  const nativeLogin = async (button, how) => {
    busy(button, true);
    try {
      const session = await (how === 'site' ? api.loginViaWebsite() : api.login());
      if (session?.connected) {
        toast(`Logged in${session.name ? ` as ${session.name}` : ''}.`, 'success');
        await onConnected(session);
      }
    } catch (err) {
      toast(err.message, 'error', 8000);
    } finally {
      busy(button, false);
    }
  };

  root.onsubmit = (e) => {
    e.preventDefault();
    const form = e.target;
    const button = form.querySelector('[type="submit"]');
    if (form.dataset.form === 'login') {
      const value = form.input.value.trim();
      if (!value) return toast('Paste your login details first.', 'error');
      connect(value, button);
    } else {
      const value = form.entry.value.trim();
      if (!/^\d+$/.test(value)) return toast('Your team ID is a number, like 1234567.', 'error');
      connect(value, button);
    }
  };

  root.onclick = async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'native-login' || action === 'site-login') {
      nativeLogin(e.target.closest('button'), action === 'site-login' ? 'site' : 'oauth');
      return;
    }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(SNIPPET);
        toast('Snippet copied. Paste it into the console on the FPL tab.', 'success');
      } catch {
        toast('Copy failed. Select the snippet text and copy it yourself.', 'error');
      }
    }
    if (action === 'demo') {
      const { input } = await api.demoLogin();
      root.querySelector('#login-input').value = input;
    }
  };
}

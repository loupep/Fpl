# FPL Manager

An Android app (and a computer version) for managing your Fantasy Premier League team:

- **Pick Team**: choose your starting XI, change your bench order, pick your captain and vice-captain, and play Bench Boost or Triple Captain. It only allows legal formations and explains why a swap isn't allowed.
- **Transfers**: sell a player, browse replacements (search, filter by position, club and price, sort by points, form, price and more), and see your bank balance, free transfers and points cost as you go. You can play Wildcard or Free Hit, undo planned transfers, then confirm with FPL.
- **Points**: your score for any gameweek this season, player by player.
- **Fixtures**: a colour-coded difficulty table for every club over the next 3 to 10 gameweeks, showing how many of your players each club has.
- **Player details**: stats, injury news, the next five fixtures and recent scores.

## On your Android phone

The app in `android/` runs on its own on your phone, with no computer needed. **Log in with FPL** opens FPL's real login page inside the app. Sign in with your email and password, and the app carries on by itself. The login is stored only on the phone, in the app's private storage, and renews itself for about a month.

To install it, copy `FPL-Manager.apk` to the phone, open it, and allow your browser or file manager to install apps when Android asks. Xiaomi phones may also show a security scan first.

To build the APK yourself you need the Android SDK (Android Studio installs it) and JDK 17 or newer:

```bash
cd android
./gradlew assembleRelease     # creates app/build/outputs/apk/release/app-release.apk
```

The app's screens are the same web app the computer version uses (`public/`), which the build copies into the APK. A small Java layer (`android/app/src/main/java`) shows FPL's login page and passes the app's requests straight to FPL.

If you normally sign in to FPL with Google or Facebook, that doesn't work inside other apps. Use **Forgot password** on the login page to give your account a password, then log in with your email and that password.

## On a computer

There's nothing to install apart from [Node.js](https://nodejs.org) 18.17 or newer, and no third-party packages.

### Try it with a pretend league

```bash
npm run demo
```

Open <http://localhost:3000>. Demo mode runs a made-up league on your computer, so you can click around and save changes without touching your real FPL team.

### Use it with your real team

```bash
npm start
```

Open <http://localhost:3000> and choose how to connect:

#### Log in (to save changes)

FPL has no official way for other apps to log in, so FPL Manager borrows the login your browser already has:

1. Log in at [fantasy.premierleague.com](https://fantasy.premierleague.com) in Chrome, Edge, Firefox or Safari.
2. On that tab, open the browser console: <kbd>F12</kbd> (Windows) or <kbd>⌥ ⌘ J</kbd> (Mac, Chrome) and choose **Console**.
3. Press **Copy snippet** in FPL Manager, paste it into the console and press <kbd>Enter</kbd>. Chrome may ask you to type `allow pasting` first. The snippet only reads your login and copies it to your clipboard.
4. Paste the result into FPL Manager and press **Connect**.

FPL Manager renews the login by itself for about 30 days. When it renews, the FPL website in that browser may log you out; just log in there again. When the login finally expires, the app asks you to repeat the steps.

You can also paste just an access token: the value after `Bearer ` in the `x-api-authorization` header of any request in the browser's **Network** tab. That kind lasts a few hours and can't renew itself.

#### View only (no login)

Enter your team ID, which is the number in the address of your **Points** page (`/entry/1234567/event/12`). You can look at your squad, plan transfers and line-ups, and check fixtures, but you can't save. View-only mode uses today's prices as selling prices and lets you set your free transfers by hand, because FPL only shares those details after you log in.

## Privacy and safety

- Your login is saved in `.fpl-session.json` in this folder (on Mac and Linux, only your user account can read it). Git ignores it. Delete the file, or press **Log out** in the app, to remove it.
- The login is only ever sent to FPL. The server only listens on your own computer (`127.0.0.1`) and refuses requests from other websites.
- The app only sends two kinds of change to FPL: saving your line-up and making transfers. Transfers and chips always ask you to confirm first, and transfers show the points cost before you agree.

## Things to know

- **This uses FPL's unofficial API.** It is undocumented and FPL changes it from time to time, especially the login. If something stops working, the error message from FPL is shown in the app.
- **FPL's terms** restrict automated access to the game. Using your own login to manage your own team is how community tools like this work, but it's your call.
- **Tested against a pretend FPL.** Saving a team and making transfers were tested against a built-in imitation of the FPL API (the same one demo mode uses), not a real account. The request formats, login settings and error codes were checked against the FPL website's own code, and the screens were checked with real FPL data. Try a small change first, such as swapping your vice-captain, and check it on the FPL website.
- **Cancelling a chip:** turning off Bench Boost or Triple Captain and saving asks FPL to cancel it. If FPL keeps it active, the app tells you and you can cancel it on the FPL website.
- **Free transfers and points cost** are worked out from the numbers FPL gives. FPL makes the final calculation when you confirm.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to serve the app on, e.g. `PORT=3001 npm start` |
| `HOST` | `127.0.0.1` | Address to listen on. Keep it local. |

## For developers

```text
android/             the Android app: hosts the web app, shows FPL's login page, sends requests to FPL
server.js            computer version's local web server; forwards app requests to FPL with your login
lib/fpl-client.js    Node wrapper for the FPL client (keeps the login in a file)
public/              the web app (plain JavaScript modules, no build step)
  js/fpl-core.js     FPL API client shared by both versions: login, token renewal, errors, caching
  js/backends.js     how requests reach FPL on a computer (local server) and on Android (the app)
  js/rules.js        game rules: formations, substitutions, captaincy, transfers, budget
  js/views/          Pick Team, Transfers, Points, Fixtures, connect screen, player details
mock/mock-fpl.js     pretend FPL API used by demo mode and the tests
test/                unit tests and browser tests
```

Run the tests with `npm test`. The browser tests need [Playwright](https://playwright.dev) (`npm install --no-save playwright && npx playwright install chromium`) and are skipped without it.

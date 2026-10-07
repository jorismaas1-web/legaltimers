# Legal Timers

A free, unbranded chess-clock timer for lawyers and tax advisers. Start a
timer per matter, switch between them like a chess clock (starting one
pauses the other), and get a rounded day and week overview you can copy
into whatever you bill with.

## Privacy promise

Everything stays in your browser's local storage. The page makes zero
network requests after it loads: no analytics, no external fonts or CDNs,
no fetch, no XHR, no WebSocket. This is enforced by a Content Security
Policy, not just a promise, so you can check it yourself: open the browser
DevTools Network tab and reload the page. Nothing should appear.

If you clear your browser data, your times are gone. Make a backup once in
a while (Instellingen / Settings -> Backup).

## Run locally

No build step. Serve the `public/` folder over HTTP (the page uses ES
modules, which browsers refuse to load from a plain `file://` URL):

```bash
python3 -m http.server -d public
```

Then open `http://localhost:8000`.

## Test

```bash
node --test
```

Tests cover the pure logic in `public/src/core.js` (chess-clock rule, elapsed
time, midnight splitting, rounding, parsing, week aggregation, and so on)
and the storage load/save and backup validation in `public/src/storage.js`.

## Deploy

Static site on Cloudflare Pages, connected to this GitHub repo: every push
to `main` deploys to production, other branches get a preview URL. Pages
settings: no framework preset, no build command, build output directory
`public`. Only `public/` is served; docs and tests are not. The
`public/_headers` file ships the Content Security Policy and other security
headers.

## Code layout

Everything that is served lives in `public/`:

- `index.html`, `styles.css` - markup and styling.
- `_headers` - CSP and security headers for Cloudflare Pages.
- `src/app.js` - DOM and UI wiring.
- `src/core.js` - pure logic, no DOM or storage access, testable in
  isolation.
- `src/storage.js` - localStorage load/save and schema validation.
- `src/i18n.js` - NL/EN string dictionary.
- `test/*.test.js` - tests, run with the Node built-in test runner.

See `docs/SPEC.md` for the full product spec and `docs/BETA.md` for the
(Dutch) guide for beta testers.

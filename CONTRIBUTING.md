# Contributing to Legal Timers

Thanks for helping out. Legal Timers is small on purpose, so please read
this before you open a pull request.

## Ground rules

These are part of the product, not style preferences. A pull request that
breaks one of them will not be merged.

- **No network.** The page makes zero requests after it loads. No
  analytics, no external fonts, CDNs or images, no `fetch`, XHR, WebSocket
  or beacons. The CSP in `public/_headers` and `public/index.html` enforces
  this; do not loosen it. CI greps the served code for network calls.
- **No dependencies, no build step.** Plain HTML, CSS and JavaScript (ES
  modules). Anything that needs `npm install` to run or test is out.
- **No inline scripts or inline styles in the HTML** (the CSP forbids
  them). Setting `element.style` from JavaScript is fine.
- **No branding.** No company, employer or personal names in the product.
- **Local only.** Accounts, sync, servers and integrations with
  time-tracking or billing software are out of scope. So are rates, billing
  codes, PWA/offline install and analytics. See "Out of scope" in
  [docs/SPEC.md](docs/SPEC.md).

If you are unsure whether an idea fits, open an issue first and ask.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Run the site locally: `python3 -m http.server -d public`, then open
   `http://localhost:8000`.
3. Put logic in `public/src/core.js` (pure functions, time passed in as
   `now`, no DOM or storage access) and add tests in `test/core.test.js`.
   Keep `public/src/app.js` to DOM wiring.
4. Every user-facing string goes in `public/src/i18n.js`, in **both** `nl`
   and `en`. `test/i18n.test.js` fails if the keys or `{placeholders}`
   differ.
5. If you change the stored data shape, update the validation in
   `public/src/storage.js` and its tests, and make sure existing data and
   old backups still load. People's billable hours live in there.
6. If behaviour changes, update [docs/SPEC.md](docs/SPEC.md) in the same
   pull request.
7. Run `node --test` (Node.js 20+) and check the change by hand in a
   browser, in both NL and EN, with the DevTools Network tab open.
8. Open a pull request describing what changed and why.

## Style

- Match the surrounding code: 2-space indent, single quotes, semicolons,
  small functions, comments only where the why is not obvious.
- Commit messages: short, imperative, saying what the change does
  ("Add a delete button per row in the Day view").
- No em-dashes in code, comments or docs. Use commas, colons, parentheses
  or separate sentences.

## Reporting bugs

Use the bug report template. Say which browser and version you use, what
you did, what you expected and what happened. **Do not include real client
names, matter numbers or descriptions** in issues or screenshots; use made-up
ones.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

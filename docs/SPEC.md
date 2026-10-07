# legaltimers.com spec

A free, unbranded chess-clock timer for lawyers and tax advisers. Reference: the
Legal Sense "Timers" (chessclocks) page. Agreed in a grilling session on 2026-10-07.

## Principles

- Simple. Plain HTML + CSS + JavaScript (ES modules), no framework, no build step,
  no dependencies.
- Local only. All data lives in the browser's localStorage. The page makes zero
  network requests after load: no analytics, no external fonts/CDNs, no fetch/XHR.
- Enforced by CSP: `default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none';
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Set in `_headers`
  (Cloudflare Pages) and mirrored in a `<meta http-equiv>` tag (frame-ancestors
  only in `_headers`). No inline scripts or inline styles (no `style=` attributes
  set from HTML; setting `element.style` from JS is fine).
- No branding: no Lowkey, no employer, no personal names. Name: "Legal Timers".
- Not installable (no PWA, no service worker).

## Clock (one card)

- Dossier line: one free-text field, e.g. "Client BV / Matter / 2002100001".
  Autocomplete (datalist is fine) from dossiers used before, most recent first.
- Time: shown as hh:mm:ss, editable by hand (parse h:mm, h:mm:ss, decimal "1.5").
- Buttons: Start / Pause, Gereed, delete (✕) with a confirm dialog.
- Chess-clock rule: at most one clock runs. Starting one immediately pauses the
  running one. No confirmation.
- "Pause all" button for breaks.
- "New timer" adds an empty card at the end, dossier field focused.

## Time model

- Timestamp based. A running clock stores `startedAt` (ms). Elapsed time =
  accumulated + (now - startedAt). Survives tab close, sleep, crash.
- Time is logged per local calendar day as segments `{clockId, start, end}`.
  A segment crossing midnight is split at local midnight.
- New day: card time displays 0:00:00 (today's total for that clock). Cards
  (dossier) persist across days.
- Manual time edits store a per-day adjustment for that clock so that today's
  total equals the entered value.
- Long-run check: when a clock has run > 3 hours continuously, or ran past
  midnight, show a banner "Liep deze echt door?" with options keep / correct
  (set end time).

## Gereed and day summary

- Gereed: pauses the clock (if running) and marks that clock's time for today as
  ready in the day summary. The card stays for tomorrow.
- Day summary: one row per clock with time today > 0:
  dossier, exact time (h:mm:ss), rounded hours, description (free text,
  stored per day per clock), "overgenomen" checkbox.
- Rounding: default 6-minute units, rounded up (7 min -> 0.2 h). Setting:
  unit 1/5/6/10/15 min, mode up/nearest. Display format setting: decimal (1.7)
  or h:mm (1:42). 0 seconds rounds to 0.
- Copy buttons per row, in AFAS field order (Project, Aantal, Toelichting;
  werksoort is not copied; there is no activity field at all): dossier number (the last "/"-separated part if it
  is numeric, else full dossier line), hours (rounded, in chosen format;
  decimal comma when the UI is NL), description.
- Clicking the row (outside inputs/buttons) toggles "overgenomen".
- "Kopieer dag als tabel": TSV with header: date, dossier, hours,
  description.
- Total today shown at the top of the page.

## Week view

- Table: dossiers as rows, Mon-Sun columns, rounded hours per cell, totals per
  day and per week. Previous / next week arrows; "this week" button.
- Days with rows not yet "overgenomen" get a dot marker.
- History kept indefinitely; settings has "delete everything older than X weeks".

## Backup

- Export backup: download a JSON file (via Blob + object URL, no network).
- Import backup: file input, validate shape, replace data after confirm.
- First-use notice: "Alles blijft in je browser. Wis je je browsergegevens, dan
  ben je je tijden kwijt. Maak af en toe een backup."

## UI

- Card grid like Legal Sense (2-3 columns desktop, 1 column mobile).
- Running card: clear colored border + background tint.
- Browser tab title while running: "▶ 0:42 · <dossier>" (h:mm of today's total).
  Otherwise "Legal Timers".
- Keyboard shortcuts (ignored while typing in an input): 1-9 start/switch clock
  at that position, Space pause all, N new timer. Listed in a small help line.
- System font, calm neutral styling, light/dark via prefers-color-scheme.
- Line on the page: "Alles blijft in je browser. Deze site verstuurt niets." plus
  a short "how to check" note (DevTools Network tab).
- Views: Timers (default) / Dag / Week / Instellingen, as tabs on one page.

## Language

- NL and EN, toggle in header; default from `navigator.language` (nl* -> NL,
  else EN); choice stored locally. All strings in one dictionary module.
- Keep Legal Sense terms in NL: "Gereed", "Tijdsoverzicht vandaag",
  "Nieuwe timer".

## Code layout

- `index.html`, `styles.css`, `src/app.js` (DOM/UI), `src/core.js` (pure logic:
  clock state transitions, segments, day split, rounding, week aggregation,
  parsing/formatting), `src/storage.js` (localStorage load/save + schema version),
  `src/i18n.js`.
- `core.js` has no DOM or storage access; time is passed in (`now`) so it is
  testable.
- Tests: `test/*.test.js` with `node --test` (built-in runner, no deps).
- `_headers` for Cloudflare Pages with the CSP and `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal.

## Out of scope

Accounts, sync, server, API/integration with time-tracking software, file import
into those programs, rates, billable codes, PWA/offline install, analytics.

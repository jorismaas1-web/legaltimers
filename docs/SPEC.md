# Legal Timers spec

A free, unbranded chess-clock timer for lawyers and tax advisers, modelled on the
chess-clock timers found in Dutch legal practice-management software. This is the
product spec the code is built against; keep it in sync when behaviour changes.

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
- No branding: no company, employer or personal names in the product. Name: "Legal Timers".
- Not installable (no PWA, no service worker).

## Clock (one card)

- Dossier line: one free-text field, e.g. "Client BV / Matter / 2002100001".
  Autocomplete (datalist is fine) from dossiers used before, most recent first.
- Time: shown as hh:mm:ss, editable by hand (parse h:mm, h:mm:ss, decimal "1.5"
  or "1,5"). Input above 24 hours, or not a finite number, is refused (the
  weekly target accepts up to 168 hours).
- Renaming a card changes today, not earlier days: time before today
  (segments, adjustments, day data, and the part of a run before today's
  midnight, which the run then continues from) moves to an archived card with
  the old dossier. Today's time stays with the renamed card, so a typo fixed
  the same day just renames. A card with no earlier time, or no old dossier,
  just renames.
- Description line under the dossier: today's description for this clock (the
  same value the day summary shows and copies). Suggestions (datalist) from
  earlier descriptions on any card with the same dossier, most recent first.
- Buttons: Start / Pause, Gereed, Declarabel / Niet declarabel toggle,
  delete (✕) with a confirm dialog.
- Chess-clock rule: at most one clock runs. Starting one immediately pauses the
  running one. No confirmation.
- "Pause all" button for breaks.
- "Delete all timers" button (shown from two cards on), with a confirm dialog
  naming the count. Same rule as ✕: the cards go, logged time stays in Day
  and Week; a running clock is paused first.
- "New timer" adds an empty card at the end, dossier field focused.
- Multiple tabs: a tab picks up the state another tab saved (storage event,
  also when storage is cleared). The stored state carries a revision number
  that each save raises by one. A save from a tab that missed a newer save is
  refused: the tab reloads the stored state and shows a notice that its last
  action was not saved. So a stale tab can lose its own last action (it must
  be repeated) but never deletes another tab's data.
- If the browser refuses local storage, a warning says the last change was not
  saved; it stays until a later save succeeds.
- Unreadable stored data is never silently replaced: the raw text is copied to
  a `legaltimers:v1:unreadable-<time>` key, a banner says so, and a button
  downloads that copy. The copy is never deleted by the app.
- Backup import is validated strictly (types, unique ids, references, ranges,
  size caps, no newer schema version) and dry-run rendered before it replaces
  anything; on failure the current data stays untouched. An accepted import is
  a deliberate overwrite and wins over other tabs.

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
  midnight, show a banner "Liep deze echt door?" (naming the dossier) with
  options keep / correct. Keep stores the time it was chosen; the banner
  comes back after 3 more hours or on a new day (an old "keep" string never
  asks again). Correct asks for the clock time you stopped
  (e.g. 17:30); an end time before the start means the next day, and the end
  is never later than now. When the clocks go back, the repeated hour is
  resolved so the end is after the start (02:15 to 02:45 is 30 minutes).

## Gereed and day summary

- Gereed: pauses the clock (if running) and marks that clock's time for today as
  ready: the button shows "Gereed ✓" and the day summary row gets a "Gereed"
  badge. Changing that day's time afterwards (starting the clock again, editing
  the time, or a manual entry) clears both the Gereed mark and "overgenomen",
  so added time is never left marked as already booked. The card stays
  for tomorrow.
- Day summary: today by default, with previous / today / next day buttons
  (no future days), so a past day can still be entered. One row per clock with
  time that day > 0:
  dossier, exact time (h:mm:ss), rounded hours, description (free text,
  stored per day per clock), "overgenomen" checkbox.
- Manual entries: "Tijd toevoegen" opens an inline form above the table
  (dossier with autocomplete, time as h:mm / h:mm:ss / decimal, description
  with suggestions, declarabel checkbox defaulting to what the dossier's
  timer has that day) for the day shown, so past days work too. The time
  adds to that dossier's timer for that day (stored as an adjustment);
  descriptions are joined with "; ". A dossier without a timer gets an
  archived one, so the entry shows in Day and Week but adds no card. If the
  timer already has time that day with the other billable flag, the entry goes
  to another timer of the dossier with the matching flag (or a new archived
  one), so existing time is never reclassified: the dossier gets two rows.
- The exact time in each row is editable (same input formats); it sets
  that day's time for the timer, and 0 removes the row.
- Each row has a delete button (✕, with a confirm dialog) that removes that
  timer's time on that day, with the day's description and marks. A running
  timer whose run touches that day is stopped first. Other days and the
  card stay.
- Rounding: default 6-minute units, rounded up (7 min -> 0.2 h). Setting:
  unit 1/5/6/10/15 min, mode up/nearest. Display format setting: decimal (1.7)
  or h:mm (1:42). Less than 30 seconds on a day (a misclick) rounds to 0 and
  the row is not shown. In decimal format a total is the sum of the rows'
  2-decimal hours (three 5-minute rows copy as 0.08 each and total 0.24); in
  h:mm format totals are summed in whole minutes, so they never drift.
- Copy buttons per row, in AFAS field order (Project, Aantal, Toelichting;
  werksoort is not copied; there is no activity field at all): dossier number (the last "/"-separated part if it
  is numeric, else full dossier line), hours (rounded, in chosen format;
  decimal comma when the UI is NL), description.
- Clicking the row (outside inputs/buttons) toggles "overgenomen". Ticking
  stores the rounded minutes at that moment; the mark only counts while the
  row still rounds to that amount (more time, a changed rounding setting).
  Otherwise the row shows as not entered with "eerder overgenomen: 1,5" next
  to the checkbox. Billable and description edits do not affect it, and marks
  from before this rule (no stored amount) always count.
- Copy for the day table (TSV): text cells starting with =, + or @, or with -
  followed by a non-space non-digit, get a leading apostrophe so spreadsheets
  keep them as text. Date and hours columns are untouched.
- Copy buttons briefly show ✓ (or ✗ if the browser refused).
- "Kopieer dag als tabel": TSV with header: date, project, dossier, hours,
  description, billable (labels in the UI language). Tabs/newlines inside fields become spaces.
- Total today shown at the top of the page.

## Billable / non-billable

- Time is billable by default. The card toggle sets the clock's default from
  today on, stored as a list of changes per clock (`billableChanges:
  [[day, bool]]`), so earlier days never change; today drops any per-day
  choice and follows the card. The card shows today's value, with
  "(vandaag)" when today differs from the card default.
- A card that gets the dossier of an earlier non-billable card takes over
  that setting (e.g. an internal dossier recreated next week).
- The day summary has a toggle per row that changes only that day.
- Totals use rounded hours (each row rounded, then summed), as booked: in
  decimal format the sum of the 2-decimal row values, in h:mm whole minutes.
- Header: next to the exact total, the rounded total split into billable and
  non-billable ("afgerond 2,6: 1,2 declarabel, 1,4 niet declarabel").
- Day summary: footer row with total, billable, non-billable and % billable.
- Week view: non-billable cells shaded and italic; day headers show the date
  ("Ma 5/10") and the whole header cell opens the day; footer rows total / billable /
  non-billable; a line with the week split and % billable.
- Settings: weekly billable target in hours (empty = off). When set, the
  week view shows progress ("x of y, z to go") with a progress bar.
- "Kopieer dag als tabel" adds project number and billable (ja/nee) columns,
  with headers in the UI language.

## Week view

- Table: dossiers as rows, Mon-Sun columns, rounded hours per cell, totals per
  day and per week. Previous / next week arrows; "this week" button.
- Days with rows not yet "overgenomen" get a dot marker. Clicking a day
  header opens that day in the Day view.
- History kept indefinitely; settings has "delete everything older than X weeks". A clock still running from before the cutoff continues from the cutoff, so pausing never brings deleted days back.

## Backup

- Export backup: download a JSON file (via Blob + object URL, no network).
- Import backup: file input, validate shape, replace data after confirm.
  Missing settings fall back to defaults.
- First-use notice: "Alles blijft in je browser. Wis je je browsergegevens, dan
  ben je je tijden kwijt. Maak af en toe een backup."

## UI

- Card grid (2-3 columns desktop, 1 column mobile).
- Running card: clear colored border + background tint.
- Browser tab title while running: "▶ 0:42 · <dossier>" (h:mm of today's total).
  Otherwise "Legal Timers".
- Keyboard shortcuts (Timers view only; ignored while typing in an input, with
  Ctrl/Cmd/Alt held, or while a dialog is open): 1-9 start/switch clock
  at that position, Space pause all, N new timer. Listed in a small help line.
  Space keeps its normal meaning (pressing the button) only on a control the
  user reached with the keyboard (`:focus-visible`, and not a control that
  got focus from a pointer press); after clicking a button, Space still
  pauses all. A held key does not repeat the action, and N does not type
  into the new dossier field (default prevented).
- System font, calm neutral styling, light/dark via prefers-color-scheme.
- No badge next to the title.
- Line on the page: "Alles blijft in je browser. Deze site verstuurt niets." plus
  a short "how to check" note (DevTools Network tab).
- Views: Timers (default) / Dag / Week / Instellingen, as tabs on one page.

## Language

- NL and EN, toggle in header; default from `navigator.language` (nl* -> NL,
  else EN); choice stored locally. All strings in one dictionary module.
- The NL strings use the terms Dutch practice software uses ("Gereed",
  "Tijdsoverzicht vandaag", "Nieuwe timer", "Overgenomen"). The EN strings are
  plain English ("Done", "Time overview today", "New timer", "Entered"). Both
  dictionaries have the same keys (checked by `test/i18n.test.js`).

## Code layout

- Served files live in `public/` (Pages build output directory):
  `index.html`, `styles.css`, `_headers`, `src/app.js` (DOM/UI), `src/core.js` (pure logic:
  clock state transitions, segments, day split, rounding, week aggregation,
  parsing/formatting), `src/storage.js` (localStorage load/save + schema version),
  `src/i18n.js`.
- `core.js` has no DOM or storage access; time is passed in (`now`) so it is
  testable.
- Tests: `test/*.test.js` with `node --test` (built-in runner, no deps), run by
  GitHub Actions on every push and pull request.
- `_headers` for Cloudflare Pages with the CSP and `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal.

## Out of scope

Accounts, sync, server, API/integration with time-tracking software, file import
into those programs, rates, billable codes or werksoorten (only a billable yes/no
flag), PWA/offline install, analytics.

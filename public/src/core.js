// Pure logic: clock state transitions, segments, day split, rounding, week
// aggregation, parsing/formatting. No DOM access, no storage access. Every
// function that needs "now" takes it as a parameter so it stays testable.

export const SCHEMA_VERSION = 1;

// Less than this on a day (a misclick on 1-9) is not time worth booking.
export const MIN_BOOKABLE_MS = 30 * 1000;

// ---------- state shape ----------
//
// state = {
//   schemaVersion: 1,
//   clocks: [{ id, dossier, createdAt, archived?, billableChanges? }],
//     // billableChanges: [[day, bool], ...] ascending; the last one at or before
//     // a day is the card default for that day; none = billable
//   segments: [{ clockId, start, end }],      // finalized, each within one local day
//   running: { clockId, startedAt } | null,   // at most one clock runs
//   adjustments: { "<clockId>__<day>": deltaMs },
//   dayData: { "<clockId>__<day>": { description, dossier?, overgenomen, overgenomenMinutes?, ready, billable? } },
//     // dossier: the dossier line when the description was saved
//     // billable unset = follow the card default
//     // overgenomenMinutes: the rounded minutes that were entered when the row
//     // was ticked; the mark only counts while the row still rounds to that
//     // (unset = legacy data, the mark always counts)
//   longRunDecisions: { "<clockId>__<startedAt>": "keep" | { keptAt } | { correctedEnd } },
//     // "keep" is the legacy form (never asked again); { keptAt } asks again
//     // after 3 hours or a new day
//   settings: {
//     roundUnitMinutes, roundMode, hoursFormat,
//     language, deleteOlderThanWeeks, weeklyBillableNorm
//   },
//   nextClockSeq: number
// }

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    clocks: [],
    segments: [],
    running: null,
    adjustments: {},
    dayData: {},
    longRunDecisions: {},
    settings: {
      roundUnitMinutes: 6,
      roundMode: 'up',
      hoursFormat: 'decimal',
      language: null,
      deleteOlderThanWeeks: null,
      weeklyBillableNorm: null,
    },
    nextClockSeq: 1,
    dossierHistory: [],
  };
}

function clone(state) {
  return {
    ...state,
    clocks: state.clocks.map((c) => ({ ...c })),
    segments: state.segments.map((s) => ({ ...s })),
    running: state.running ? { ...state.running } : null,
    adjustments: { ...state.adjustments },
    dayData: { ...state.dayData },
    longRunDecisions: { ...state.longRunDecisions },
    settings: { ...state.settings },
    dossierHistory: Array.isArray(state.dossierHistory) ? [...state.dossierHistory] : [],
  };
}

// ---------- local date helpers ----------

export function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getWeekStart(ms) {
  const dayStart = startOfLocalDay(ms);
  const weekday = new Date(dayStart).getDay(); // 0=Sun..6=Sat
  const diffFromMonday = (weekday + 6) % 7;
  return addDays(dayStart, -diffFromMonday);
}

// ---------- segments ----------

export function splitSegment(seg) {
  const { start, end } = seg;
  if (end <= start) return [];
  const out = [];
  let cur = start;
  while (cur < end) {
    const dayStart = startOfLocalDay(cur);
    const nextMidnight = addDays(dayStart, 1);
    const segEnd = Math.min(end, nextMidnight);
    out.push({ clockId: seg.clockId, start: cur, end: segEnd });
    cur = segEnd;
  }
  return out;
}

function adjKey(clockId, day) {
  return `${clockId}__${day}`;
}

// ---------- clock CRUD ----------

export function addClock(state, { dossier = '' }, now, id) {
  const next = clone(state);
  const clockId = id || `c${next.nextClockSeq}`;
  next.nextClockSeq = next.nextClockSeq + 1;
  next.clocks.push({ id: clockId, dossier, createdAt: now });
  return { state: next, clockId };
}

// Archives a clock: the card disappears from the timers grid, but its
// segments, adjustments and day data stay so past days and weeks still add up.
export function removeClock(state, clockId, now) {
  const next =
    state.running && state.running.clockId === clockId ? pauseRunning(state, now) : clone(state);
  next.clocks = next.clocks.map((c) => (c.id === clockId ? { ...c, archived: true } : c));
  return next;
}

// Archives every active clock at once (same rules as removeClock).
export function removeAllClocks(state, now) {
  const next = pauseRunning(state, now);
  next.clocks = next.clocks.map((c) => (c.archived ? c : { ...c, archived: true }));
  return next;
}

export function activeClocks(state) {
  return state.clocks.filter((c) => !c.archived);
}

export function updateClock(state, clockId, patch) {
  const next = clone(state);
  next.clocks = next.clocks.map((c) => (c.id === clockId ? { ...c, ...patch } : c));
  return next;
}

// Renames a card without rewriting history: a card reused for another client
// must not move its earlier days to that client. Time on days before today
// (segments, adjustments, day data, and the part of a run from before today's
// midnight) moves to an archived card that keeps the old dossier; today stays
// with the renamed card, so a typo fixed the same day still works.
export function renameClock(state, clockId, dossier, now) {
  const clock = state.clocks.find((c) => c.id === clockId);
  const today = dayKey(now);
  const todayStart = startOfLocalDay(now);
  const oldDossier = ((clock && clock.dossier) || '').trim();
  if (!clock || !oldDossier || oldDossier === (dossier || '').trim()) {
    return updateClock(state, clockId, { dossier });
  }
  const earlierKey = (key) => {
    const [id, day] = key.split('__');
    return id === clockId && day && day < today;
  };
  const oldSegments = state.segments.filter((s) => s.clockId === clockId && dayKey(s.start) < today);
  const oldAdjustments = Object.keys(state.adjustments).filter(earlierKey);
  const oldDayData = Object.keys(state.dayData).filter(earlierKey);
  const runBefore = state.running && state.running.clockId === clockId && state.running.startedAt < todayStart;
  if (!oldSegments.length && !oldAdjustments.length && !oldDayData.length && !runBefore) {
    return updateClock(state, clockId, { dossier });
  }

  const next = clone(state);
  const archivedId = `c${next.nextClockSeq}`;
  next.nextClockSeq += 1;
  const archived = { id: archivedId, dossier: clock.dossier, createdAt: clock.createdAt, archived: true };
  if (clock.billableChanges) archived.billableChanges = clock.billableChanges.map((c) => [...c]);
  next.clocks.push(archived);
  next.segments = next.segments.map((s) =>
    s.clockId === clockId && dayKey(s.start) < today ? { ...s, clockId: archivedId } : s,
  );
  for (const key of oldAdjustments) {
    next.adjustments[adjKey(archivedId, key.split('__')[1])] = next.adjustments[key];
    delete next.adjustments[key];
  }
  for (const key of oldDayData) {
    next.dayData[adjKey(archivedId, key.split('__')[1])] = next.dayData[key];
    delete next.dayData[key];
  }
  if (runBefore) {
    const { startedAt } = next.running;
    // The long-run decision is keyed by startedAt; carry it to the new key.
    const oldKey = `${clockId}__${startedAt}`;
    if (next.longRunDecisions && next.longRunDecisions[oldKey] !== undefined) {
      next.longRunDecisions[`${clockId}__${todayStart}`] = next.longRunDecisions[oldKey];
      delete next.longRunDecisions[oldKey];
    }
    next.segments.push(...splitSegment({ clockId: archivedId, start: startedAt, end: todayStart }));
    next.running = { ...next.running, startedAt: todayStart };
  }
  next.clocks = next.clocks.map((c) => (c.id === clockId ? { ...c, dossier } : c));
  return next;
}

export function recordDossierUsed(state, dossier) {
  const value = (dossier || '').trim();
  if (!value) return clone(state);
  const next = clone(state);
  next.dossierHistory = [value, ...next.dossierHistory.filter((d) => d !== value)].slice(0, 200);
  return next;
}

export function updateSettings(state, patch) {
  const next = clone(state);
  next.settings = { ...next.settings, ...patch };
  return next;
}

// Removes segments, adjustments and day data for days older than
// `weeks` weeks ago (local time). Active clock cards are kept; archived
// clocks with no history left are dropped.
export function pruneOlderThan(state, weeks, now) {
  const next = clone(state);
  const cutoff = addDays(startOfLocalDay(now), -weeks * 7);
  next.segments = next.segments.filter((s) => s.start >= cutoff);
  // A run started before the cutoff would bring the deleted days back when
  // it is paused, so it continues from the cutoff.
  if (next.running && next.running.startedAt < cutoff) next.running.startedAt = cutoff;
  for (const key of Object.keys(next.adjustments)) {
    const day = key.split('__')[1];
    if (day && new Date(`${day}T00:00:00`).getTime() < cutoff) delete next.adjustments[key];
  }
  for (const key of Object.keys(next.dayData)) {
    const day = key.split('__')[1];
    if (day && new Date(`${day}T00:00:00`).getTime() < cutoff) delete next.dayData[key];
  }
  const used = new Set(next.segments.map((s) => s.clockId));
  for (const key of [...Object.keys(next.adjustments), ...Object.keys(next.dayData)]) {
    used.add(key.split('__')[0]);
  }
  next.clocks = next.clocks.filter((c) => !c.archived || used.has(c.id));
  return next;
}

// ---------- chess-clock transitions ----------

export function pauseRunning(state, now) {
  if (!state.running) return clone(state);
  const next = clone(state);
  const { clockId, startedAt } = next.running;
  const parts = splitSegment({ clockId, start: startedAt, end: now });
  next.segments.push(...parts);
  next.running = null;
  return next;
}

// Time on a row changed after it was marked: it is no longer final (Gereed)
// and the new total still has to be booked (overgenomen). Mutates `next`,
// which the caller has already cloned.
function reopenDay(next, clockId, day) {
  const key = adjKey(clockId, day);
  if (next.dayData[key]) {
    const { overgenomenMinutes, ...rest } = next.dayData[key];
    next.dayData[key] = { ...rest, ready: false, overgenomen: false };
  }
}

export function startClock(state, clockId, now) {
  let next = state.running ? pauseRunning(state, now) : clone(state);
  next = clone(next);
  next.running = { clockId, startedAt: now };
  reopenDay(next, clockId, dayKey(now));
  return next;
}

export function pauseAll(state, now) {
  return pauseRunning(state, now);
}

// ---------- elapsed time ----------

function rawSegmentsTotalForDay(state, clockId, day, now) {
  let total = 0;
  for (const s of state.segments) {
    if (s.clockId !== clockId) continue;
    if (dayKey(s.start) !== day) continue;
    total += s.end - s.start;
  }
  if (state.running && state.running.clockId === clockId) {
    const parts = splitSegment({ clockId, start: state.running.startedAt, end: now });
    for (const p of parts) {
      if (dayKey(p.start) === day) total += p.end - p.start;
    }
  }
  return total;
}

// Every clock's time for one day in a single pass over the segments.
// Segments never cross midnight, so comparing `start` against the day's
// bounds is enough.
export function elapsedByClock(state, day, now) {
  const dayStart = new Date(`${day}T00:00:00`).getTime();
  const dayEnd = addDays(dayStart, 1);
  const out = new Map();
  const add = (id, ms) => out.set(id, (out.get(id) || 0) + ms);
  for (const s of state.segments) {
    if (s.start >= dayStart && s.start < dayEnd) add(s.clockId, s.end - s.start);
  }
  if (state.running) {
    const { clockId, startedAt } = state.running;
    const start = Math.max(startedAt, dayStart);
    const end = Math.min(now, dayEnd);
    if (end > start) add(clockId, end - start);
  }
  const suffix = `__${day}`;
  for (const [key, ms] of Object.entries(state.adjustments)) {
    if (key.endsWith(suffix)) add(key.slice(0, -suffix.length), ms);
  }
  return out;
}

export function elapsedForDay(state, clockId, day, now) {
  const raw = rawSegmentsTotalForDay(state, clockId, day, now);
  const adj = state.adjustments[adjKey(clockId, day)] || 0;
  return raw + adj;
}

export function setManualElapsed(state, clockId, day, targetMs, now) {
  const next = clone(state);
  const raw = rawSegmentsTotalForDay(next, clockId, day, now);
  const key = adjKey(clockId, day);
  if (raw + (next.adjustments[key] || 0) !== targetMs) reopenDay(next, clockId, day);
  next.adjustments[key] = targetMs - raw;
  return next;
}

// ---------- day data (description / overgenomen / ready) ----------

function getDayData(state, clockId, day) {
  return state.dayData[adjKey(clockId, day)] || { description: '', overgenomen: false, ready: false };
}

export function getDescription(state, clockId, day) {
  return getDayData(state, clockId, day).description || '';
}

// Also remembers the dossier line, so suggestions stay with the dossier the
// text was written for even if the card is later renamed.
export function setDescription(state, clockId, day, description) {
  const next = clone(state);
  const key = adjKey(clockId, day);
  const clock = next.clocks.find((c) => c.id === clockId);
  const dossier = ((clock && clock.dossier) || '').trim();
  next.dayData[key] = { ...getDayData(next, clockId, day), description, dossier };
  return next;
}

// Ticking stores the rounded minutes the row had at that moment (`minutes`),
// so the mark stops counting once the row rounds to something else.
export function setOvergenomen(state, clockId, day, value, minutes) {
  const next = clone(state);
  const key = adjKey(clockId, day);
  const { overgenomenMinutes, ...rest } = getDayData(next, clockId, day);
  next.dayData[key] = { ...rest, overgenomen: !!value };
  if (value && Number.isFinite(minutes)) next.dayData[key].overgenomenMinutes = minutes;
  return next;
}

// The mark counts only for the amount that was entered. Legacy marks without
// a stored amount always count.
function enteredState(dd, roundedMinutes) {
  if (!dd.overgenomen) return { entered: false };
  const stored = dd.overgenomenMinutes;
  if (typeof stored !== 'number' || stored === roundedMinutes) return { entered: true };
  return { entered: false, enteredMinutes: stored };
}

export function markReady(state, clockId, day, now) {
  let next = state.running && state.running.clockId === clockId ? pauseRunning(state, now) : clone(state);
  next = clone(next);
  const key = adjKey(clockId, day);
  next.dayData[key] = { ...getDayData(next, clockId, day), ready: true };
  return next;
}

export function isReady(state, clockId, day) {
  return getDayData(state, clockId, day).ready;
}

// ---------- manual entries ----------

// The timer an entry for this dossier belongs to: a card first, else the
// most recent deleted card with that dossier.
function findClockByDossier(state, dossier) {
  const value = (dossier || '').trim();
  if (!value) return null;
  const same = state.clocks.filter((c) => (c.dossier || '').trim() === value);
  return same.find((c) => !c.archived) || same.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

export function billableForDossier(state, dossier, day) {
  const clock = findClockByDossier(state, dossier);
  return clock ? isBillable(state, clock.id, day) : true;
}

// Books time written by hand on a day. It adds to the dossier's timer for
// that day; a dossier without a timer gets one that stays off the Timers
// grid (archived), so the entry only shows in Day and Week. If that timer
// already has time that day with the other billable flag, the entry goes to
// another timer of the dossier (one with the matching flag, or a new archived
// one) instead of reclassifying the existing time: two rows for the dossier.
// Returns { state, clockId }, or null for an empty dossier or no time.
export function addManualEntry(state, { dossier, day, ms, description = '', billable = true }, now) {
  const value = (dossier || '').trim();
  if (!value || !(ms > 0)) return null;
  let next = clone(state);
  let clock = findClockByDossier(next, value);
  const addArchivedClock = () => {
    const res = addClock(next, { dossier: value }, now);
    next = res.state;
    next.clocks = next.clocks.map((c) => (c.id === res.clockId ? { ...c, archived: true } : c));
    return next.clocks.find((c) => c.id === res.clockId);
  };
  if (!clock) {
    clock = addArchivedClock();
  } else if (
    isBillable(next, clock.id, day) !== !!billable &&
    (elapsedByClock(next, day, now).get(clock.id) || 0) >= MIN_BOOKABLE_MS
  ) {
    const other = next.clocks
      .filter((c) => c.id !== clock.id && (c.dossier || '').trim() === value && isBillable(next, c.id, day) === !!billable)
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.createdAt - a.createdAt)[0];
    clock = other || addArchivedClock();
  }
  const key = adjKey(clock.id, day);
  next.adjustments[key] = (next.adjustments[key] || 0) + ms;
  reopenDay(next, clock.id, day);
  const text = description.trim();
  if (text) {
    const existing = getDescription(next, clock.id, day).trim();
    next = setDescription(next, clock.id, day, existing ? `${existing}; ${text}` : text);
  }
  next = setDayBillable(next, clock.id, day, billable);
  next = recordDossierUsed(next, value);
  return { state: next, clockId: clock.id };
}

// Removes all of one timer's time on one day, with that day's description
// and marks. A running timer whose run touches that day is stopped first,
// otherwise the row would come straight back. Other days stay as they are.
export function deleteDayTime(state, clockId, day, now) {
  const runsThatDay =
    state.running &&
    state.running.clockId === clockId &&
    splitSegment({ clockId, start: state.running.startedAt, end: now }).some((p) => dayKey(p.start) === day);
  const next = runsThatDay ? pauseRunning(state, now) : clone(state);
  next.segments = next.segments.filter((s) => !(s.clockId === clockId && dayKey(s.start) === day));
  delete next.adjustments[adjKey(clockId, day)];
  delete next.dayData[adjKey(clockId, day)];
  return next;
}

// ---------- billable / non-billable ----------

export function clockBillableDefault(state, clockId, day) {
  const clock = state.clocks.find((c) => c.id === clockId);
  let value = true;
  for (const [from, billable] of (clock && clock.billableChanges) || []) {
    if (from <= day) value = billable;
  }
  return value;
}

export function isBillable(state, clockId, day) {
  const dd = state.dayData[adjKey(clockId, day)];
  if (dd && typeof dd.billable === 'boolean') return dd.billable;
  return clockBillableDefault(state, clockId, day);
}

export function setDayBillable(state, clockId, day, value) {
  const next = clone(state);
  const key = adjKey(clockId, day);
  next.dayData[key] = { ...getDayData(next, clockId, day), billable: !!value };
  return next;
}

// The card toggle: sets the default from today on (earlier days keep the
// default they had) and drops any per-day choice for today.
export function setClockBillable(state, clockId, value, now) {
  const next = clone(state);
  const today = dayKey(now);
  const todayKey = adjKey(clockId, today);
  if (next.dayData[todayKey]) {
    const { billable, ...rest } = next.dayData[todayKey];
    next.dayData[todayKey] = rest;
  }
  next.clocks = next.clocks.map((c) =>
    c.id === clockId
      ? { ...c, billableChanges: [...(c.billableChanges || []).filter(([d]) => d < today), [today, !!value]] }
      : c,
  );
  return next;
}

// A card that gets the dossier of an earlier card (e.g. an internal dossier
// recreated next week) takes over that card's billable setting.
export function adoptBillableFromDossier(state, clockId, now) {
  const clock = state.clocks.find((c) => c.id === clockId);
  const dossier = ((clock && clock.dossier) || '').trim();
  if (!clock || !dossier || (clock.billableChanges || []).length > 0) return state;
  const today = dayKey(now);
  const earlier = state.clocks
    .filter((c) => c.id !== clockId && (c.dossier || '').trim() === dossier && (c.billableChanges || []).length > 0)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!earlier || clockBillableDefault(state, earlier.id, today)) return state;
  return setClockBillable(state, clockId, false, now);
}

// Hours for a list of rounded-minute cells. In decimal format each cell is
// the 2-decimal number that gets copied (5 min = 0.08), so a total is the sum
// of those, not of the exact minutes; h:mm keeps whole-minute sums.
function hoursOf(minutesList, settings) {
  const sum = minutesList.reduce((a, b) => a + b, 0);
  if (settings.hoursFormat !== 'decimal') return sum / 60;
  return round2(minutesList.reduce((a, m) => a + round2(m / 60), 0));
}

// Rounded time for day-summary rows, split by billable flag. Each row is
// rounded on its own (that is what gets booked); totals add up what is shown
// per row (see hoursOf).
export function daySplit(rows, settings) {
  const all = [];
  const billable = [];
  const nonBillable = [];
  for (const r of rows) {
    const m = roundMinutes(r.elapsedMs, settings.roundUnitMinutes, settings.roundMode);
    all.push(m);
    (r.billable ? billable : nonBillable).push(m);
  }
  return {
    total: hoursOf(all, settings),
    billable: hoursOf(billable, settings),
    nonBillable: hoursOf(nonBillable, settings),
  };
}

export function billableShare(billableHours, totalHours) {
  if (!(totalHours > 0)) return null;
  return Math.round((billableHours / totalHours) * 100);
}

// ---------- description suggestions ----------

// Earlier descriptions written for the same dossier (on any of its cards),
// most recent day first, without duplicates.
export function descriptionSuggestions(state, dossier, limit = 30) {
  const target = (dossier || '').trim();
  if (!target) return [];
  // Older entries without a dossier snapshot fall back to the card's dossier.
  const ids = new Set(state.clocks.filter((c) => (c.dossier || '').trim() === target).map((c) => c.id));
  const entries = [];
  for (const [key, dd] of Object.entries(state.dayData)) {
    const [id, day] = key.split('__');
    const text = (dd && typeof dd.description === 'string' ? dd.description : '').trim();
    const sameDossier = typeof dd.dossier === 'string' ? dd.dossier === target : ids.has(id);
    if (sameDossier && text) entries.push({ day, text });
  }
  entries.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const out = [];
  for (const e of entries) {
    if (!out.includes(e.text)) out.push(e.text);
    if (out.length >= limit) break;
  }
  return out;
}

export function getDaySummaryRows(state, day, now) {
  const byClock = elapsedByClock(state, day, now);
  const rows = [];
  for (const c of state.clocks) {
    const elapsed = byClock.get(c.id) || 0;
    if (elapsed < MIN_BOOKABLE_MS) continue;
    const dd = getDayData(state, c.id, day);
    const roundedMinutes = roundMinutes(elapsed, state.settings.roundUnitMinutes, state.settings.roundMode);
    const { entered, enteredMinutes } = enteredState(dd, roundedMinutes);
    const row = {
      clockId: c.id,
      dossier: c.dossier,
      elapsedMs: elapsed,
      roundedMinutes,
      description: dd.description,
      overgenomen: entered,
      ready: dd.ready,
      billable: isBillable(state, c.id, day),
    };
    // Marked as entered for another amount: the UI shows it as not entered
    // and says what was entered before.
    if (enteredMinutes !== undefined) row.enteredMinutes = enteredMinutes;
    rows.push(row);
  }
  return rows;
}

// ---------- long-run detection ----------

export function isLongRun(startedAt, now, thresholdMs = 3 * 3600 * 1000) {
  if (now - startedAt > thresholdMs) return true;
  if (dayKey(startedAt) !== dayKey(now)) return true;
  return false;
}

// Whether the long-run question is due for the running clock. No decision:
// ask when it is a long run. { keptAt }: ask again after 3 more hours or on a
// new day (a kept run that sleeps through a weekend is still questioned).
// Legacy "keep": never ask again.
export function needsLongRunReview(running, decision, now, thresholdMs = 3 * 3600 * 1000) {
  if (!running) return false;
  if (decision === 'keep') return false;
  if (decision && typeof decision.keptAt === 'number') {
    return now - decision.keptAt > thresholdMs || dayKey(decision.keptAt) !== dayKey(now);
  }
  return isLongRun(running.startedAt, now, thresholdMs);
}

// ---------- rounding ----------

function round2(x) {
  return Math.round((x + 1e-9) * 100) / 100;
}

// Rounded time in whole minutes (a multiple of the unit).
export function roundMinutes(ms, unitMinutes, mode) {
  if (ms < MIN_BOOKABLE_MS) return 0;
  const unitMs = unitMinutes * 60 * 1000;
  // 'up': any time beyond an exact multiple of the unit rounds up to the
  // next unit; an exact multiple stays as-is.
  const units = mode === 'nearest' ? Math.round(ms / unitMs) : Math.ceil((ms - 1) / unitMs);
  return units * unitMinutes;
}

export function roundHoursMs(ms, unitMinutes, mode) {
  return round2(roundMinutes(ms, unitMinutes, mode) / 60);
}

// ---------- formatting ----------

export function formatDecimalHours(h, decimalSeparator = '.') {
  return String(round2(h)).replace('.', decimalSeparator);
}

export function formatHM(h) {
  const totalMinutes = Math.round(h * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${hh}:${String(mm).padStart(2, '0')}`;
}

export function formatHMS(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------- parsing ----------

// Null for anything unparseable, not finite, or above `maxHours` (one day's
// time for one matter cannot exceed 24 hours; the weekly norm passes a bigger
// bound).
export function parseTimeInput(str, maxHours = 24) {
  const ms = parseTimeMs(str);
  return Number.isFinite(ms) && ms <= maxHours * 3600 * 1000 ? ms : null;
}

function parseTimeMs(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;

  let m = s.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);
  if (m) {
    const [, h, mi, se] = m;
    return ((Number(h) * 60 + Number(mi)) * 60 + Number(se)) * 1000;
  }

  m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) {
    const [, h, mi] = m;
    return (Number(h) * 60 + Number(mi)) * 60 * 1000;
  }

  m = s.match(/^\d+([.,]\d+)?$/);
  if (m) {
    return Math.round(Number(s.replace(',', '.')) * 3600 * 1000);
  }

  return null;
}

// Turns a clock time ("17:30" or "17.30") into the end timestamp of a run that
// started at `startedAt`: the first such moment after the start (so a run past
// midnight ends the next day), never later than `now`. Null if unparseable.
export function resolveEndTime(startedAt, str, now) {
  const m = typeof str === 'string' && str.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const d = new Date(startedAt);
  d.setHours(h, mi, 0, 0);
  let end = d.getTime();
  if (end <= startedAt) {
    // The hour that repeats when clocks go back: setHours picks the first
    // 02:45, so the same wall time an hour later may be the one after the start.
    const later = end + 3600 * 1000;
    const l = new Date(later);
    if (later > startedAt && l.getHours() === h && l.getMinutes() === mi) return Math.min(later, now);
    const n = new Date(end);
    n.setDate(n.getDate() + 1);
    end = n.getTime();
  }
  return Math.min(end, now);
}

// ---------- dossier number extraction ----------

export function extractDossierNumber(dossierLine) {
  const line = (dossierLine || '').trim();
  const parts = line
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return line;
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) return last;
  return line;
}

// ---------- TSV ----------

function tsvField(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ');
}

// Free text pasted into a spreadsheet must stay text: a leading apostrophe
// stops "=SUM(...)" and the like from becoming a formula. "-" only counts
// when it is followed by something other than a space and the cell is not a
// plain number ("-5", "-", "- note" are harmless, "-1+1" is a formula).
function tsvText(v) {
  const s = tsvField(v);
  const formula = /^[=+@]/.test(s) || (/^-\S/.test(s) && !/^-\d+([.,]\d+)?$/.test(s));
  return formula ? `'${s}` : s;
}

export const TSV_COLUMNS = ['date', 'project', 'dossier', 'hours', 'description', 'billable'];
const TSV_NUMERIC = new Set(['date', 'hours']);

// `header` maps each column to its label (defaults to the column names).
export function buildDayTSV(rows, header = {}) {
  const lines = [TSV_COLUMNS.map((c) => tsvText(header[c] ?? c)).join('\t')];
  for (const r of rows) {
    lines.push(TSV_COLUMNS.map((c) => (TSV_NUMERIC.has(c) ? tsvField(r[c]) : tsvText(r[c]))).join('\t'));
  }
  return lines.join('\n');
}

// ---------- week aggregation ----------

export function aggregateWeek(state, weekStartMs, now, settings) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(dayKey(addDays(weekStartMs, i)));
  const byDay = days.map((day) => elapsedByClock(state, day, now));

  // Rounded minutes of every row cell, per day; totals are built from these
  // with hoursOf so they equal what the cells show.
  const cells = { all: days.map(() => []), billable: days.map(() => []), nonBillable: days.map(() => []) };
  const rows = [];
  for (const c of state.clocks) {
    const mins = byDay.map((m) => roundMinutes(m.get(c.id) || 0, settings.roundUnitMinutes, settings.roundMode));
    if (!mins.some((m) => m > 0)) continue;
    const billable = days.map((day) => isBillable(state, c.id, day));
    mins.forEach((m, i) => {
      cells.all[i].push(m);
      cells[billable[i] ? 'billable' : 'nonBillable'][i].push(m);
    });
    rows.push({ clockId: c.id, dossier: c.dossier, hours: mins.map((m) => m / 60), billable, total: hoursOf(mins, settings) });
  }

  const perDay = (lists) => lists.map((l) => hoursOf(l, settings));
  const week = (lists) => hoursOf(lists.flat(), settings);
  return {
    days,
    rows,
    dayTotals: perDay(cells.all),
    weekTotal: week(cells.all),
    billableDayTotals: perDay(cells.billable),
    nonBillableDayTotals: perDay(cells.nonBillable),
    billableWeekTotal: week(cells.billable),
    nonBillableWeekTotal: week(cells.nonBillable),
  };
}

export function weekHasUnprocessed(state, day, now) {
  const byClock = elapsedByClock(state, day, now);
  for (const c of state.clocks) {
    if ((byClock.get(c.id) || 0) < MIN_BOOKABLE_MS) continue;
    const rounded = roundMinutes(byClock.get(c.id), state.settings.roundUnitMinutes, state.settings.roundMode);
    if (!enteredState(getDayData(state, c.id, day), rounded).entered) return true;
  }
  return false;
}

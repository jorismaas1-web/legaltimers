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
//   dayData: { "<clockId>__<day>": { description, dossier?, overgenomen, ready, billable? } },
//     // dossier: the dossier line when the description was saved
//     // billable unset = follow the card default
//   longRunDecisions: { "<clockId>__<startedAt>": "keep" | { correctedEnd } },
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

export function activeClocks(state) {
  return state.clocks.filter((c) => !c.archived);
}

export function updateClock(state, clockId, patch) {
  const next = clone(state);
  next.clocks = next.clocks.map((c) => (c.id === clockId ? { ...c, ...patch } : c));
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
  if (next.dayData[key]) next.dayData[key] = { ...next.dayData[key], ready: false, overgenomen: false };
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

export function setOvergenomen(state, clockId, day, value) {
  const next = clone(state);
  const key = adjKey(clockId, day);
  next.dayData[key] = { ...getDayData(next, clockId, day), overgenomen: !!value };
  return next;
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
// grid (archived), so the entry only shows in Day and Week. Returns
// { state, clockId }, or null for an empty dossier or no time.
export function addManualEntry(state, { dossier, day, ms, description = '', billable = true }, now) {
  const value = (dossier || '').trim();
  if (!value || !(ms > 0)) return null;
  let next = clone(state);
  let clock = findClockByDossier(next, value);
  if (!clock) {
    const res = addClock(next, { dossier: value }, now);
    next = res.state;
    next.clocks = next.clocks.map((c) => (c.id === res.clockId ? { ...c, archived: true } : c));
    clock = next.clocks.find((c) => c.id === res.clockId);
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

// Rounded time for day-summary rows, split by billable flag. Each row is
// rounded on its own (that is what gets booked); sums are kept in whole
// minutes so h:mm totals never drift.
export function daySplit(rows, settings) {
  let billable = 0;
  let nonBillable = 0;
  for (const r of rows) {
    const m = roundMinutes(r.elapsedMs, settings.roundUnitMinutes, settings.roundMode);
    if (r.billable) billable += m;
    else nonBillable += m;
  }
  return { total: (billable + nonBillable) / 60, billable: billable / 60, nonBillable: nonBillable / 60 };
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
    rows.push({
      clockId: c.id,
      dossier: c.dossier,
      elapsedMs: elapsed,
      description: dd.description,
      overgenomen: dd.overgenomen,
      ready: dd.ready,
      billable: isBillable(state, c.id, day),
    });
  }
  return rows;
}

// ---------- long-run detection ----------

export function isLongRun(startedAt, now, thresholdMs = 3 * 3600 * 1000) {
  if (now - startedAt > thresholdMs) return true;
  if (dayKey(startedAt) !== dayKey(now)) return true;
  return false;
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

export function parseTimeInput(str) {
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

export const TSV_COLUMNS = ['date', 'project', 'dossier', 'hours', 'description', 'billable'];

// `header` maps each column to its label (defaults to the column names).
export function buildDayTSV(rows, header = {}) {
  const lines = [TSV_COLUMNS.map((c) => tsvField(header[c] ?? c)).join('\t')];
  for (const r of rows) {
    lines.push(TSV_COLUMNS.map((c) => tsvField(r[c])).join('\t'));
  }
  return lines.join('\n');
}

// ---------- week aggregation ----------

export function aggregateWeek(state, weekStartMs, now, settings) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(dayKey(addDays(weekStartMs, i)));
  const byDay = days.map((day) => elapsedByClock(state, day, now));

  const rows = [];
  const minutes = { all: [0, 0, 0, 0, 0, 0, 0], billable: [0, 0, 0, 0, 0, 0, 0] };
  for (const c of state.clocks) {
    const mins = byDay.map((m) => roundMinutes(m.get(c.id) || 0, settings.roundUnitMinutes, settings.roundMode));
    if (!mins.some((m) => m > 0)) continue;
    const billable = days.map((day) => isBillable(state, c.id, day));
    mins.forEach((m, i) => {
      minutes.all[i] += m;
      if (billable[i]) minutes.billable[i] += m;
    });
    const hours = mins.map((m) => m / 60);
    rows.push({ clockId: c.id, dossier: c.dossier, hours, billable, total: sumOf(mins) / 60 });
  }

  const toHours = (xs) => xs.map((m) => m / 60);
  return {
    days,
    rows,
    dayTotals: toHours(minutes.all),
    weekTotal: sumOf(minutes.all) / 60,
    billableDayTotals: toHours(minutes.billable),
    nonBillableDayTotals: minutes.all.map((m, i) => (m - minutes.billable[i]) / 60),
    billableWeekTotal: sumOf(minutes.billable) / 60,
    nonBillableWeekTotal: (sumOf(minutes.all) - sumOf(minutes.billable)) / 60,
  };
}

function sumOf(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

export function weekHasUnprocessed(state, day, now) {
  const byClock = elapsedByClock(state, day, now);
  for (const c of state.clocks) {
    if ((byClock.get(c.id) || 0) < MIN_BOOKABLE_MS) continue;
    if (!getDayData(state, c.id, day).overgenomen) return true;
  }
  return false;
}

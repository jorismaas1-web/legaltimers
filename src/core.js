// Pure logic: clock state transitions, segments, day split, rounding, week
// aggregation, parsing/formatting. No DOM access, no storage access. Every
// function that needs "now" takes it as a parameter so it stays testable.

export const SCHEMA_VERSION = 1;

// ---------- state shape ----------
//
// state = {
//   schemaVersion: 1,
//   clocks: [{ id, dossier, activity, createdAt, archived? }],
//   segments: [{ clockId, start, end }],      // finalized, each within one local day
//   running: { clockId, startedAt } | null,   // at most one clock runs
//   adjustments: { "<clockId>__<day>": deltaMs },
//   dayData: { "<clockId>__<day>": { description, overgenomen, ready } },
//   longRunDecisions: { "<clockId>__<startedAt>": "keep" | { correctedEnd } },
//   settings: {
//     roundUnitMinutes, roundMode, hoursFormat, defaultActivity,
//     language, deleteOlderThanWeeks
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
      defaultActivity: '',
      language: null,
      deleteOlderThanWeeks: null,
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

export function addClock(state, { dossier = '', activity = '' }, now, id) {
  const next = clone(state);
  const clockId = id || `c${next.nextClockSeq}`;
  next.nextClockSeq = next.nextClockSeq + 1;
  next.clocks.push({ id: clockId, dossier, activity, createdAt: now });
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

export function startClock(state, clockId, now) {
  let next = state.running ? pauseRunning(state, now) : clone(state);
  next = clone(next);
  next.running = { clockId, startedAt: now };
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

export function elapsedForDay(state, clockId, day, now) {
  const raw = rawSegmentsTotalForDay(state, clockId, day, now);
  const adj = state.adjustments[adjKey(clockId, day)] || 0;
  return raw + adj;
}

export function setManualElapsed(state, clockId, day, targetMs, now) {
  const next = clone(state);
  const raw = rawSegmentsTotalForDay(next, clockId, day, now);
  next.adjustments[adjKey(clockId, day)] = targetMs - raw;
  return next;
}

export function totalForDayAllClocks(state, day, now) {
  let total = 0;
  for (const c of state.clocks) total += elapsedForDay(state, c.id, day, now);
  return total;
}

// ---------- day data (description / overgenomen / ready) ----------

function getDayData(state, clockId, day) {
  return state.dayData[adjKey(clockId, day)] || { description: '', overgenomen: false, ready: false };
}

export function setDescription(state, clockId, day, description) {
  const next = clone(state);
  const key = adjKey(clockId, day);
  next.dayData[key] = { ...getDayData(next, clockId, day), description };
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

export function getDaySummaryRows(state, day, now) {
  const rows = [];
  for (const c of state.clocks) {
    const elapsed = elapsedForDay(state, c.id, day, now);
    if (elapsed <= 0) continue;
    const dd = getDayData(state, c.id, day);
    rows.push({
      clockId: c.id,
      dossier: c.dossier,
      activity: c.activity,
      elapsedMs: elapsed,
      description: dd.description,
      overgenomen: dd.overgenomen,
      ready: dd.ready,
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

export function roundHoursMs(ms, unitMinutes, mode) {
  if (ms <= 0) return 0;
  const unitMs = unitMinutes * 60 * 1000;
  let units;
  if (mode === 'nearest') {
    units = Math.round(ms / unitMs);
  } else {
    // 'up': any time beyond an exact multiple of the unit rounds up to the
    // next unit; an exact multiple stays as-is.
    units = Math.ceil((ms - 1) / unitMs);
  }
  const minutes = units * unitMinutes;
  return round2(minutes / 60);
}

// ---------- formatting ----------

export function formatDecimalHours(h) {
  return String(round2(h));
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

  m = s.match(/^\d+(\.\d+)?$/);
  if (m) {
    return Math.round(Number(s) * 3600 * 1000);
  }

  return null;
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

export function buildDayTSV(rows) {
  const header = ['date', 'dossier', 'activity', 'hours', 'description'];
  const lines = [header.join('\t')];
  for (const r of rows) {
    lines.push([r.date, r.dossier, r.activity, r.hours, r.description].join('\t'));
  }
  return lines.join('\n');
}

// ---------- week aggregation ----------

export function aggregateWeek(state, weekStartMs, now, settings) {
  const unitMinutes = settings.roundUnitMinutes;
  const mode = settings.roundMode;
  const days = [];
  for (let i = 0; i < 7; i++) days.push(dayKey(addDays(weekStartMs, i)));

  const rows = [];
  for (const c of state.clocks) {
    const hours = days.map((day) => roundHoursMs(elapsedForDay(state, c.id, day, now), unitMinutes, mode));
    const total = round2(hours.reduce((a, b) => a + b, 0));
    const hasAny = hours.some((h) => h > 0);
    if (!hasAny) continue;
    rows.push({ clockId: c.id, dossier: c.dossier, activity: c.activity, hours, total });
  }

  const dayTotals = days.map((_, i) => round2(rows.reduce((a, r) => a + r.hours[i], 0)));
  const weekTotal = round2(dayTotals.reduce((a, b) => a + b, 0));

  return { days, rows, dayTotals, weekTotal };
}

export function weekHasUnprocessed(state, day, now) {
  for (const c of state.clocks) {
    const elapsed = elapsedForDay(state, c.id, day, now);
    if (elapsed <= 0) continue;
    const dd = getDayData(state, c.id, day);
    if (!dd.overgenomen) return true;
  }
  return false;
}

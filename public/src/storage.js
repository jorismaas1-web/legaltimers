// localStorage load/save + schema validation. The only module that touches
// a storage backend; it is handed a `backend` object (localStorage, or a
// fake with the same getItem/setItem shape) so it stays testable.

import { createInitialState, SCHEMA_VERSION, startOfLocalDay, addDays } from './core.js';

export const STORAGE_KEY = 'legaltimers:v1';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Lenient shape check for state read back from storage: the fields code
// elsewhere relies on, nothing stricter, so data this app wrote in an earlier
// version keeps loading (normalizeState repairs small type problems).
export function isValidState(data) {
  if (!isPlainObject(data)) return false;
  if (typeof data.schemaVersion !== 'number') return false;
  if (!Array.isArray(data.clocks)) return false;
  if (!Array.isArray(data.segments)) return false;
  if (!isPlainObject(data.adjustments)) return false;
  if (!isPlainObject(data.dayData)) return false;
  if (!isPlainObject(data.settings)) return false;
  if (data.running !== null && data.running !== undefined && !isPlainObject(data.running)) return false;

  for (const c of data.clocks) {
    if (!isPlainObject(c)) return false;
    if (typeof c.id !== 'string') return false;
  }
  for (const s of data.segments) {
    if (!isPlainObject(s)) return false;
    if (typeof s.clockId !== 'string') return false;
    if (typeof s.start !== 'number' || typeof s.end !== 'number') return false;
  }
  return true;
}

// ---------- strict validation (imports) ----------

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_CLOCKS = 20000;
export const MAX_SEGMENTS = 500000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROUND_UNITS = [1, 5, 6, 10, 15];

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBoolOrAbsent(v) {
  return v === undefined || typeof v === 'boolean';
}

function isStringOrAbsent(v) {
  return v === undefined || typeof v === 'string';
}

function isPosInt(v) {
  return Number.isInteger(v) && v > 0;
}

function settingsProblem(st) {
  if (!isPlainObject(st)) return 'settings';
  const has = (k) => st[k] !== undefined;
  if (has('roundUnitMinutes') && !ROUND_UNITS.includes(st.roundUnitMinutes)) return 'settings.roundUnitMinutes';
  if (has('roundMode') && !['up', 'nearest'].includes(st.roundMode)) return 'settings.roundMode';
  if (has('hoursFormat') && !['decimal', 'hm'].includes(st.hoursFormat)) return 'settings.hoursFormat';
  if (has('language') && ![null, 'nl', 'en'].includes(st.language)) return 'settings.language';
  if (has('deleteOlderThanWeeks') && st.deleteOlderThanWeeks !== null && !isPosInt(st.deleteOlderThanWeeks)) {
    return 'settings.deleteOlderThanWeeks';
  }
  if (has('weeklyBillableNorm') && st.weeklyBillableNorm !== null && !(isFiniteNum(st.weeklyBillableNorm) && st.weeklyBillableNorm > 0)) {
    return 'settings.weeklyBillableNorm';
  }
  return null;
}

function clockProblem(c, ids) {
  if (!isPlainObject(c)) return 'clock is not an object';
  if (typeof c.id !== 'string' || c.id === '') return 'clock id';
  if (ids.has(c.id)) return `duplicate clock id ${c.id}`;
  ids.add(c.id);
  if (typeof c.dossier !== 'string') return 'clock dossier';
  if (!isFiniteNum(c.createdAt)) return 'clock createdAt';
  if (!isBoolOrAbsent(c.archived)) return 'clock archived';
  if (c.billableChanges !== undefined) {
    if (!Array.isArray(c.billableChanges)) return 'clock billableChanges';
    for (const b of c.billableChanges) {
      if (!Array.isArray(b) || b.length !== 2 || typeof b[0] !== 'string' || !DAY_RE.test(b[0]) || typeof b[1] !== 'boolean') {
        return 'clock billableChanges entry';
      }
    }
  }
  return null;
}

// "<clockId>__YYYY-MM-DD" pointing at an existing clock.
function dayKeyProblem(key, ids, label) {
  const i = key.lastIndexOf('__');
  if (i < 0 || !ids.has(key.slice(0, i)) || !DAY_RE.test(key.slice(i + 2))) return `${label} key ${key}`;
  return null;
}

function dayDataProblem(v) {
  if (!isPlainObject(v)) return 'dayData value';
  if (!isStringOrAbsent(v.description) || !isStringOrAbsent(v.dossier)) return 'dayData text';
  if (!isBoolOrAbsent(v.overgenomen) || !isBoolOrAbsent(v.ready) || !isBoolOrAbsent(v.billable)) return 'dayData flag';
  if (v.overgenomenMinutes !== undefined && !isFiniteNum(v.overgenomenMinutes)) return 'dayData overgenomenMinutes';
  return null;
}

function isDecision(v) {
  if (v === 'keep') return true;
  return isPlainObject(v) && (isFiniteNum(v.keptAt) || isFiniteNum(v.correctedEnd));
}

// Strict check for imported backups: everything the renderer relies on, with
// size caps. Returns { ok: true } or { ok: false, reason }.
export function validateBackup(data) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPlainObject(data)) return fail('not an object');
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) return fail('schemaVersion');
  if (data.schemaVersion > SCHEMA_VERSION) return fail('newer schemaVersion');
  if (!Array.isArray(data.clocks)) return fail('clocks');
  if (!Array.isArray(data.segments)) return fail('segments');
  if (data.clocks.length > MAX_CLOCKS) return fail('too many clocks');
  if (data.segments.length > MAX_SEGMENTS) return fail('too many segments');
  if (!isPlainObject(data.adjustments)) return fail('adjustments');
  if (!isPlainObject(data.dayData)) return fail('dayData');

  const ids = new Set();
  for (const c of data.clocks) {
    const p = clockProblem(c, ids);
    if (p) return fail(p);
  }
  for (const s of data.segments) {
    if (!isPlainObject(s) || typeof s.clockId !== 'string' || !ids.has(s.clockId)) return fail('segment clockId');
    if (!isFiniteNum(s.start) || !isFiniteNum(s.end)) return fail('segment times');
    // Within one local day (a DST-end day is 25 hours long, so no fixed cap).
    if (!(s.start < s.end) || s.end > addDays(startOfLocalDay(s.start), 1)) return fail('segment range');
  }
  if (data.running !== null && data.running !== undefined) {
    const r = data.running;
    if (!isPlainObject(r) || !ids.has(r.clockId) || !isFiniteNum(r.startedAt)) return fail('running');
  }
  for (const [k, v] of Object.entries(data.adjustments)) {
    const p = dayKeyProblem(k, ids, 'adjustments');
    if (p) return fail(p);
    if (!isFiniteNum(v)) return fail('adjustments value');
  }
  for (const [k, v] of Object.entries(data.dayData)) {
    const p = dayKeyProblem(k, ids, 'dayData') || dayDataProblem(v);
    if (p) return fail(p);
  }
  if (data.longRunDecisions !== undefined) {
    if (!isPlainObject(data.longRunDecisions)) return fail('longRunDecisions');
    for (const v of Object.values(data.longRunDecisions)) if (!isDecision(v)) return fail('longRunDecisions value');
  }
  const sp = data.settings === undefined ? null : settingsProblem(data.settings);
  if (sp) return fail(sp);
  if (data.dossierHistory !== undefined && !(Array.isArray(data.dossierHistory) && data.dossierHistory.every((x) => typeof x === 'string'))) {
    return fail('dossierHistory');
  }
  if (data.nextClockSeq !== undefined && !isPosInt(data.nextClockSeq)) return fail('nextClockSeq');
  if (data.rev !== undefined && !(Number.isInteger(data.rev) && data.rev >= 0)) return fail('rev');
  return { ok: true };
}

// Boolean form, kept for callers that only need yes/no.
export function validateBackupShape(data) {
  return validateBackup(data).ok;
}

// ---------- normalisation ----------

function repairedSettings(raw) {
  const initial = createInitialState().settings;
  const merged = { ...initial, ...(isPlainObject(raw) ? raw : {}) };
  // Per field: keep it only if the strict rules accept it, else the default.
  for (const k of Object.keys(initial)) {
    if (settingsProblem({ [k]: merged[k] })) merged[k] = initial[k];
  }
  return merged;
}

function repairedClock(c) {
  const out = { ...c };
  if (typeof out.dossier !== 'string') out.dossier = '';
  if (!isFiniteNum(out.createdAt)) out.createdAt = 0;
  if (out.archived !== undefined && typeof out.archived !== 'boolean') delete out.archived;
  if (out.billableChanges !== undefined) {
    out.billableChanges = Array.isArray(out.billableChanges)
      ? out.billableChanges.filter((b) => Array.isArray(b) && typeof b[0] === 'string' && DAY_RE.test(b[0]) && typeof b[1] === 'boolean')
      : [];
  }
  return out;
}

// Fills in anything missing and repairs small type problems, for stored
// state (lenient: data this app wrote earlier must keep loading) and for
// imported backups (already strictly validated). No migrations yet; stamps
// the current schema version defensively.
export function normalizeState(data) {
  const initial = createInitialState();
  const ids = new Set(data.clocks.map((c) => c.id));
  const dayData = {};
  for (const [k, v] of Object.entries(data.dayData)) if (isPlainObject(v)) dayData[k] = v;
  const running = isPlainObject(data.running) && ids.has(data.running.clockId) && isFiniteNum(data.running.startedAt);
  return {
    ...initial,
    ...data,
    clocks: data.clocks.map(repairedClock),
    segments: data.segments.filter((s) => isFiniteNum(s.start) && isFiniteNum(s.end)),
    running: running ? data.running : null,
    dayData,
    settings: repairedSettings(data.settings),
    dossierHistory: Array.isArray(data.dossierHistory) ? data.dossierHistory.filter((x) => typeof x === 'string') : [],
    longRunDecisions: isPlainObject(data.longRunDecisions) ? data.longRunDecisions : {},
    nextClockSeq: isPosInt(data.nextClockSeq) ? data.nextClockSeq : initial.nextClockSeq,
    rev: Number.isInteger(data.rev) && data.rev >= 0 ? data.rev : 0,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function defaultState() {
  return createInitialState();
}

function parseRev(data) {
  return isPlainObject(data) && Number.isInteger(data.rev) && data.rev >= 0 ? data.rev : 0;
}

// Whether load() would accept this stored text (valid JSON of a shape and
// schema version this app can read).
function isLoadable(raw) {
  try {
    const data = JSON.parse(raw);
    return isValidState(data) && !(data.schemaVersion > SCHEMA_VERSION);
  } catch (e) {
    return false;
  }
}

// Wraps a backend with load/save. Two safety nets:
// - stored data that cannot be read is copied to a quarantine key before
//   anything can overwrite it (`lastLoadProblem`, `quarantineKey` and
//   `quarantinedRaw` tell the app). If that copy cannot be written, saving
//   to the main key is blocked until the app calls `releaseCopy()` (the user
//   downloaded the copy or chose to go on without it);
// - every save carries a revision, and a save from a stale snapshot (another
//   tab saved in between) is refused instead of overwriting.
export function createStorage(backend, key = STORAGE_KEY, clock = Date.now) {
  let knownRev = 0;
  const prefix = `${key}:unreadable-`;

  // An earlier copy with exactly this text (backends without key
  // enumeration just never match).
  function findExistingCopy(raw) {
    try {
      for (let i = 0; i < backend.length; i++) {
        const k = backend.key(i);
        if (k && k.startsWith(prefix) && backend.getItem(k) === raw) return k;
      }
    } catch (e) {
      // no enumeration available
    }
    return null;
  }

  const store = {
    lastLoadProblem: null, // null | 'unreadable'
    quarantineKey: null,
    quarantinedRaw: null,
    copyUnsaved: false, // the copy only exists in memory; main-key saves are blocked

    quarantine(raw) {
      store.lastLoadProblem = 'unreadable';
      store.quarantinedRaw = raw; // also kept in memory, in case the write below fails
      // Every reload of still-unreadable data would otherwise add another copy.
      const existing = findExistingCopy(raw);
      if (existing) {
        store.quarantineKey = existing;
        store.copyUnsaved = false;
        return;
      }
      store.quarantineKey = `${prefix}${clock()}`;
      try {
        backend.setItem(store.quarantineKey, raw);
        store.copyUnsaved = false;
      } catch (e) {
        store.copyUnsaved = true; // e.g. quota
      }
    },

    // The user has the copy (downloaded) or accepted going on without it.
    releaseCopy() {
      store.copyUnsaved = false;
      store.lastLoadProblem = null;
    },

    load() {
      store.lastLoadProblem = null;
      let raw = null;
      try {
        raw = backend.getItem(key);
      } catch (e) {
        return defaultState();
      }
      if (!raw) {
        knownRev = 0;
        return defaultState();
      }
      let data = null;
      try {
        data = JSON.parse(raw);
        // A newer schema is not ours to rewrite: keep it aside too.
        if (isValidState(data) && !(data.schemaVersion > SCHEMA_VERSION)) {
          const state = normalizeState(data);
          knownRev = state.rev;
          return state;
        }
      } catch (e) {
        data = null;
      }
      store.quarantine(raw);
      knownRev = parseRev(data);
      return defaultState();
    },

    // 'ok' | 'conflict' (another tab saved newer data; nothing written) |
    // 'blocked' (unreadable data has no stored copy yet; nothing written) |
    // 'failed' (the backend refused the write). `force` is for a deliberate
    // overwrite such as importing a backup.
    trySave(state, { force = false } = {}) {
      try {
        const raw = backend.getItem(key);
        let current = 0;
        if (raw) {
          try {
            current = parseRev(JSON.parse(raw));
          } catch (e) {
            // handled below
          }
          // Never overwrite anything load() refuses without a copy of it.
          if (!isLoadable(raw) && !(store.quarantinedRaw === raw && !store.copyUnsaved)) store.quarantine(raw);
        }
        if (store.copyUnsaved) return 'blocked';
        if (!force && current > knownRev) return 'conflict';
        const rev = Math.max(current, knownRev) + 1;
        backend.setItem(key, JSON.stringify({ ...state, rev }));
        knownRev = rev;
        return 'ok';
      } catch (e) {
        return 'failed';
      }
    },

    save(state, opts) {
      return store.trySave(state, opts) === 'ok';
    },
  };
  return store;
}

// localStorage load/save + schema validation. The only module that touches
// a storage backend; it is handed a `backend` object (localStorage, or a
// fake with the same getItem/setItem shape) so it stays testable.

import { createInitialState, SCHEMA_VERSION } from './core.js';

export const STORAGE_KEY = 'legaltimers:v1';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Validates the shape of a state object, whether it came from storage or
// from an imported backup file. Deliberately permissive about extra fields
// (forward-compatible) but strict about the fields code elsewhere relies on.
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

// Same check, exposed under the name used for backup-file import so callers
// can read the intent at the call site.
export function validateBackupShape(data) {
  return isValidState(data);
}

function migrate(data) {
  // No migrations yet; stamp the current schema version defensively.
  return { ...createInitialState(), ...data, schemaVersion: SCHEMA_VERSION };
}

export function defaultState() {
  return createInitialState();
}

export function createStorage(backend, key = STORAGE_KEY) {
  return {
    load() {
      try {
        const raw = backend.getItem(key);
        if (!raw) return defaultState();
        const data = JSON.parse(raw);
        if (!isValidState(data)) return defaultState();
        return migrate(data);
      } catch (e) {
        return defaultState();
      }
    },
    save(state) {
      try {
        backend.setItem(key, JSON.stringify(state));
        return true;
      } catch (e) {
        return false;
      }
    },
  };
}

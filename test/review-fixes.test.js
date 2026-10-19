import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../public/src/core.js';
import * as storage from '../public/src/storage.js';

const localMs = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

// ---- TSV formula escaping ----

test('buildDayTSV escapes a leading hyphen unless the cell is a plain number or harmless', () => {
  const cell = (description) =>
    core.buildDayTSV([{ date: '2026-10-07', dossier: 'A', hours: '1', description }]).split('\n')[1].split('\t')[4];
  assert.equal(cell('-1+1'), "'-1+1");
  assert.equal(cell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
  assert.equal(cell('-cmd'), "'-cmd");
  assert.equal(cell('-5'), '-5');
  assert.equal(cell('-1,5'), '-1,5');
  assert.equal(cell('-'), '-');
  assert.equal(cell('- item'), '- item');
});

// ---- rename keeps the long-run decision ----

test('renaming a card running since an earlier day carries its long-run decision to the new start key', () => {
  const t0 = localMs(2026, 10, 7, 16, 0);
  let { state, clockId } = core.addClock(core.createInitialState(), { dossier: 'A / 1' }, t0);
  state = core.startClock(state, clockId, t0);
  state = { ...state, longRunDecisions: { [`${clockId}__${t0}`]: { keptAt: t0 + 1 } } };
  const renamed = core.renameClock(state, clockId, 'A / 2', localMs(2026, 10, 8, 9, 0));
  const midnight = localMs(2026, 10, 8, 0, 0);
  assert.equal(renamed.running.startedAt, midnight);
  assert.deepEqual(renamed.longRunDecisions, { [`${clockId}__${midnight}`]: { keptAt: t0 + 1 } });
});

// ---- quarantine robustness ----

// A backend with key enumeration (like localStorage) and an optional key quota.
function enumBackend(initial = {}, { maxKeys = Infinity } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (!map.has(k) && map.size >= maxKeys) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    _map: map,
  };
}

const unreadableKeys = (b) => [...b._map.keys()].filter((k) => k.includes(':unreadable-'));
const newerSchema = (rev) => JSON.stringify({ ...core.createInitialState(), schemaVersion: core.SCHEMA_VERSION + 1, rev });

test('a failed quarantine copy blocks saving until releaseCopy()', () => {
  const backend = enumBackend({ 'legaltimers:v1': '{broken' }, { maxKeys: 1 });
  const store = storage.createStorage(backend);
  store.load();
  assert.equal(store.copyUnsaved, true);
  assert.equal(store.quarantinedRaw, '{broken');
  assert.equal(store.trySave(core.createInitialState()), 'blocked');
  assert.equal(backend.getItem('legaltimers:v1'), '{broken');
  store.releaseCopy();
  assert.equal(store.trySave(core.createInitialState()), 'ok');
});

test('a successful quarantine copy does not block saving', () => {
  const backend = enumBackend({ 'legaltimers:v1': '{broken' });
  const store = storage.createStorage(backend);
  store.load();
  assert.equal(store.copyUnsaved, false);
  assert.equal(store.trySave(core.createInitialState()), 'ok');
  assert.equal(unreadableKeys(backend).length, 1);
});

test('reloading still-unreadable data does not add another quarantine copy', () => {
  const backend = enumBackend({ 'legaltimers:v1': '{broken' });
  let t = 1000;
  const first = storage.createStorage(backend, undefined, () => t++);
  first.load();
  const second = storage.createStorage(backend, undefined, () => t++);
  second.load();
  assert.equal(unreadableKeys(backend).length, 1);
  assert.equal(second.lastLoadProblem, 'unreadable');
  assert.equal(second.quarantineKey, first.quarantineKey);
  // different unreadable text does get its own copy
  backend.setItem('legaltimers:v1', '{other broken');
  storage.createStorage(backend, undefined, () => t++).load();
  assert.equal(unreadableKeys(backend).length, 2);
});

test('valid JSON that load() refuses is copied before the main key can be overwritten', () => {
  const backend = enumBackend();
  const store = storage.createStorage(backend);
  store.load(); // empty
  backend.setItem('legaltimers:v1', newerSchema(3)); // appeared after load
  assert.equal(store.trySave(core.createInitialState()), 'conflict');
  const copies = unreadableKeys(backend);
  assert.equal(copies.length, 1);
  assert.equal(backend.getItem(copies[0]), newerSchema(3));
});

test('refused data whose rev is not above ours is copied first, and blocks when the copy fails', () => {
  const newer = newerSchema(0);
  const full = enumBackend({ 'legaltimers:v1': newer }, { maxKeys: 1 });
  assert.equal(storage.createStorage(full).trySave(core.createInitialState()), 'blocked');
  assert.equal(full.getItem('legaltimers:v1'), newer);

  const roomy = enumBackend({ 'legaltimers:v1': newer });
  assert.equal(storage.createStorage(roomy).trySave(core.createInitialState()), 'ok');
  assert.equal(roomy.getItem(unreadableKeys(roomy)[0]), newer);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../public/src/storage.js';
import * as core from '../public/src/core.js';

function fakeBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

test('load() returns a fresh default state when nothing is stored', () => {
  const backend = fakeBackend();
  const store = storage.createStorage(backend);
  const state = store.load();
  assert.equal(state.schemaVersion, core.SCHEMA_VERSION);
  assert.deepEqual(state.clocks, []);
});

test('save() then load() round-trips state', () => {
  const backend = fakeBackend();
  const store = storage.createStorage(backend);
  let state = core.createInitialState();
  const res = core.addClock(state, { dossier: 'Client BV / 2002100001' }, Date.now());
  state = res.state;

  store.save(state);
  const loaded = store.load();
  assert.equal(loaded.clocks.length, 1);
  assert.equal(loaded.clocks[0].dossier, 'Client BV / 2002100001');
});

test('load() falls back to default state on corrupt JSON', () => {
  const backend = fakeBackend({ 'legaltimers:v1': '{not json' });
  const store = storage.createStorage(backend);
  const state = store.load();
  assert.deepEqual(state.clocks, []);
});

test('load() falls back to default state when the shape is invalid', () => {
  const backend = fakeBackend({ 'legaltimers:v1': JSON.stringify({ clocks: 'nope' }) });
  const store = storage.createStorage(backend);
  const state = store.load();
  assert.deepEqual(state.clocks, []);
});

test('load() falls back to default state when setItem/getItem throw (e.g. storage disabled)', () => {
  const backend = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const store = storage.createStorage(backend);
  const state = store.load();
  assert.deepEqual(state.clocks, []);
  assert.equal(store.save(state), false);
});

test('isValidState accepts a well-formed state and rejects malformed ones', () => {
  const good = core.createInitialState();
  assert.equal(storage.isValidState(good), true);

  assert.equal(storage.isValidState(null), false);
  assert.equal(storage.isValidState({}), false);
  assert.equal(storage.isValidState({ ...good, clocks: 'x' }), false);
  assert.equal(storage.isValidState({ ...good, segments: null }), false);
  assert.equal(storage.isValidState({ ...good, settings: null }), false);
});

test('validateBackupShape validates an exported backup before import', () => {
  const good = core.createInitialState();
  assert.equal(storage.validateBackupShape(good), true);
  assert.equal(storage.validateBackupShape({ foo: 'bar' }), false);
  assert.equal(storage.validateBackupShape('not an object'), false);
  assert.equal(storage.validateBackupShape(null), false);
});

test('normalizeState fills missing settings with defaults (e.g. a hand-edited backup)', () => {
  const data = { ...core.createInitialState(), settings: { roundUnitMinutes: 15 } };
  const s = storage.normalizeState(data);
  assert.equal(s.settings.roundUnitMinutes, 15);
  assert.equal(s.settings.roundMode, 'up');
  assert.equal(s.settings.hoursFormat, 'decimal');
  assert.ok(Array.isArray(s.dossierHistory));
});

test('normalizeState drops a weekly billable target that is not a positive number', () => {
  const base = core.createInitialState();
  for (const bad of ['37.5', -3, 0, 'abc', null]) {
    const out = storage.normalizeState({ ...base, settings: { ...base.settings, weeklyBillableNorm: bad } });
    assert.equal(out.settings.weeklyBillableNorm, null, String(bad));
  }
  const ok = storage.normalizeState({ ...base, settings: { ...base.settings, weeklyBillableNorm: 37.5 } });
  assert.equal(ok.settings.weeklyBillableNorm, 37.5);
});

// ---------- corruption, multi-tab, strict import ----------

const KEY = storage.STORAGE_KEY;

test('unreadable JSON is quarantined, reported, and not silently replaced', () => {
  const backend = fakeBackend({ [KEY]: '{"broken' });
  const store = storage.createStorage(backend, KEY, () => 123);
  const state = store.load();
  assert.deepEqual(state.clocks, []);
  assert.equal(store.lastLoadProblem, 'unreadable');
  assert.equal(store.quarantineKey, `${KEY}:unreadable-123`);
  assert.equal(backend.getItem(store.quarantineKey), '{"broken');
  assert.equal(store.quarantinedRaw, '{"broken');
  store.save(state);
  assert.equal(backend.getItem(store.quarantineKey), '{"broken', 'the copy survives later saves');
});

test('structurally invalid or future-version stored data is quarantined too', () => {
  for (const raw of [JSON.stringify({ foo: 1 }), JSON.stringify({ ...core.createInitialState(), schemaVersion: 99 })]) {
    const backend = fakeBackend({ [KEY]: raw });
    const store = storage.createStorage(backend);
    store.load();
    assert.equal(store.lastLoadProblem, 'unreadable');
    assert.equal(backend.getItem(store.quarantineKey), raw);
  }
});

test('no data and good data report no load problem', () => {
  const store = storage.createStorage(fakeBackend());
  store.load();
  assert.equal(store.lastLoadProblem, null);
  store.save(core.createInitialState());
  store.load();
  assert.equal(store.lastLoadProblem, null);
});

test('quarantine survives a full backend (quota) and keeps the raw copy in memory', () => {
  const backend = fakeBackend({ [KEY]: 'nope' });
  backend.setItem = () => {
    throw new Error('quota');
  };
  const store = storage.createStorage(backend);
  store.load();
  assert.equal(store.lastLoadProblem, 'unreadable');
  assert.equal(store.quarantinedRaw, 'nope');
});

test('stored state from an earlier version is repaired, not quarantined', () => {
  const old = core.createInitialState();
  delete old.dossierHistory;
  delete old.nextClockSeq;
  old.settings = { roundUnitMinutes: 6, language: 42 };
  old.clocks = [{ id: 'a', dossier: 7, createdAt: 1 }];
  const backend = fakeBackend({ [KEY]: JSON.stringify(old) });
  const store = storage.createStorage(backend);
  const s = store.load();
  assert.equal(store.lastLoadProblem, null);
  assert.equal(s.settings.language, null);
  assert.equal(s.clocks[0].dossier, '');
  assert.equal(s.rev, 0);
});

test('save() bumps the revision on every successful save', () => {
  const backend = fakeBackend();
  const store = storage.createStorage(backend);
  const s = store.load();
  store.save(s);
  store.save(s);
  assert.equal(JSON.parse(backend.getItem(KEY)).rev, 2);
});

test('two tabs: a stale save is refused and reload returns the other tab data', () => {
  const backend = fakeBackend();
  const tabA = storage.createStorage(backend);
  const tabB = storage.createStorage(backend);
  let a = tabA.load();
  let b = tabB.load();

  a = core.addClock(a, { dossier: 'From A' }, 1000).state;
  assert.equal(tabA.trySave(a), 'ok');

  b = core.addClock(b, { dossier: 'From B' }, 2000).state;
  assert.equal(tabB.trySave(b), 'conflict');
  assert.equal(JSON.parse(backend.getItem(KEY)).clocks[0].dossier, 'From A', 'nothing was overwritten');

  b = tabB.load();
  assert.equal(b.clocks.length, 1);
  assert.equal(b.clocks[0].dossier, 'From A');
  b = core.addClock(b, { dossier: 'From B' }, 3000).state;
  assert.equal(tabB.trySave(b), 'ok');
  assert.equal(JSON.parse(backend.getItem(KEY)).clocks.length, 2);
  assert.equal(tabA.trySave(a), 'conflict', 'now A is the stale one');
});

test('force save (import) overwrites a newer revision and stays ahead of it', () => {
  const backend = fakeBackend();
  const tabA = storage.createStorage(backend);
  const tabB = storage.createStorage(backend);
  const a = tabA.load();
  tabB.load();
  tabA.save(a);
  tabA.save(a);
  assert.equal(tabB.trySave(a, { force: true }), 'ok');
  assert.equal(JSON.parse(backend.getItem(KEY)).rev, 3);
  assert.equal(tabB.trySave(a), 'ok');
});

test('a cleared storage (key removed by another tab) loads as empty and saves', () => {
  const backend = fakeBackend();
  const store = storage.createStorage(backend);
  store.save(store.load());
  backend.removeItem(KEY);
  const s = store.load();
  assert.deepEqual(s.clocks, []);
  assert.equal(store.trySave(s), 'ok');
});

test('a failed write reports failed, not conflict', () => {
  const backend = fakeBackend();
  const store = storage.createStorage(backend);
  const s = store.load();
  backend.setItem = () => {
    throw new Error('quota');
  };
  assert.equal(store.trySave(s), 'failed');
});

// A real backup: produced by actual core operations, as the app exports it.
function realBackup() {
  let s = core.createInitialState();
  const t0 = new Date(2026, 4, 4, 9, 0, 0).getTime();
  s = core.addClock(s, { dossier: 'Client BV / 2002100001' }, t0, 'c1').state;
  s = core.startClock(s, 'c1', t0);
  s = core.pauseAll(s, t0 + 3600 * 1000);
  s = core.setDescription(s, 'c1', core.dayKey(t0), 'Memo');
  s = core.setOvergenomen(s, 'c1', core.dayKey(t0), true);
  s = core.startClock(s, 'c1', t0 + 2 * 3600 * 1000);
  return JSON.parse(JSON.stringify(s));
}

test('validateBackup accepts a real exported backup and it survives a storage round trip', () => {
  const data = realBackup();
  assert.ok(data.segments.length > 0);
  assert.deepEqual(storage.validateBackup(data), { ok: true });
  const norm = storage.normalizeState(data);
  const backend = fakeBackend();
  const store = storage.createStorage(backend);
  store.load();
  assert.equal(store.save(norm, { force: true }), true);
  const loaded = store.load();
  assert.equal(loaded.clocks.length, 1);
  assert.equal(loaded.segments.length, data.segments.length);
  assert.ok(loaded.running);
  assert.deepEqual(storage.validateBackup(JSON.parse(backend.getItem(KEY))), { ok: true });
});

test('validateBackup accepts legacy "keep" and new { keptAt } long-run decisions, and a settings-less file', () => {
  const data = realBackup();
  data.longRunDecisions = { c1__1: 'keep', c1__2: { keptAt: 5 }, c1__3: { correctedEnd: 9 } };
  assert.equal(storage.validateBackup(data).ok, true);
  delete data.settings;
  assert.equal(storage.validateBackup(data).ok, true);
  assert.equal(storage.normalizeState(data).settings.roundUnitMinutes, 6);
});

const DK = 'c1__2026-05-04';
const REJECTED = {
  'newer schemaVersion': (d) => ({ ...d, schemaVersion: core.SCHEMA_VERSION + 1 }),
  'zero schemaVersion': (d) => ({ ...d, schemaVersion: 0 }),
  'fractional schemaVersion': (d) => ({ ...d, schemaVersion: 1.5 }),
  'language 42': (d) => ({ ...d, settings: { ...d.settings, language: 42 } }),
  'bad roundUnit': (d) => ({ ...d, settings: { ...d.settings, roundUnitMinutes: 7 } }),
  'bad roundMode': (d) => ({ ...d, settings: { ...d.settings, roundMode: 'down' } }),
  'bad hoursFormat': (d) => ({ ...d, settings: { ...d.settings, hoursFormat: 'x' } }),
  'bad deleteOlderThanWeeks': (d) => ({ ...d, settings: { ...d.settings, deleteOlderThanWeeks: 1.5 } }),
  'bad weeklyBillableNorm': (d) => ({ ...d, settings: { ...d.settings, weeklyBillableNorm: -3 } }),
  'dossier 42': (d) => ({ ...d, clocks: [{ ...d.clocks[0], dossier: 42 }] }),
  'createdAt string': (d) => ({ ...d, clocks: [{ ...d.clocks[0], createdAt: 'x' }] }),
  'archived string': (d) => ({ ...d, clocks: [{ ...d.clocks[0], archived: 'yes' }] }),
  'billableChanges [null]': (d) => ({ ...d, clocks: [{ ...d.clocks[0], billableChanges: [null] }] }),
  'billableChanges bad day': (d) => ({ ...d, clocks: [{ ...d.clocks[0], billableChanges: [['x', true]] }] }),
  'duplicate ids': (d) => ({ ...d, clocks: [d.clocks[0], { ...d.clocks[0] }] }),
  'clock null': (d) => ({ ...d, clocks: [null] }),
  'dangling segment': (d) => ({ ...d, segments: [{ clockId: 'zz', start: 1, end: 2 }] }),
  'reversed segment': (d) => ({ ...d, segments: [{ clockId: 'c1', start: 5, end: 2 }] }),
  'zero-length segment': (d) => ({ ...d, segments: [{ clockId: 'c1', start: 5, end: 5 }] }),
  'segment over 24h': (d) => ({ ...d, segments: [{ clockId: 'c1', start: 0, end: 25 * 3600 * 1000 }] }),
  'segment null end': (d) => ({ ...d, segments: [{ clockId: 'c1', start: 0, end: null }] }),
  'dangling running': (d) => ({ ...d, running: { clockId: 'zz', startedAt: 1 } }),
  'running bad startedAt': (d) => ({ ...d, running: { clockId: 'c1', startedAt: 'x' } }),
  'adjustment dangling key': (d) => ({ ...d, adjustments: { 'zz__2026-05-04': 1 } }),
  'adjustment bad key': (d) => ({ ...d, adjustments: { c1: 1 } }),
  'adjustment bad value': (d) => ({ ...d, adjustments: { [DK]: 'x' } }),
  'dayData bad key': (d) => ({ ...d, dayData: { c1__yesterday: {} } }),
  'dayData value null': (d) => ({ ...d, dayData: { [DK]: null } }),
  'dayData description number': (d) => ({ ...d, dayData: { [DK]: { description: 5 } } }),
  'dayData ready string': (d) => ({ ...d, dayData: { [DK]: { ready: 'y' } } }),
  'dayData billable string': (d) => ({ ...d, dayData: { [DK]: { billable: 'y' } } }),
  'dayData overgenomenMinutes string': (d) => ({ ...d, dayData: { [DK]: { overgenomenMinutes: '5' } } }),
  'bad decision': (d) => ({ ...d, longRunDecisions: { x: 'drop' } }),
  'decision null': (d) => ({ ...d, longRunDecisions: { x: null } }),
  'dossierHistory non-string': (d) => ({ ...d, dossierHistory: ['a', 3] }),
  'nextClockSeq 0': (d) => ({ ...d, nextClockSeq: 0 }),
  'negative rev': (d) => ({ ...d, rev: -1 }),
  'fractional rev': (d) => ({ ...d, rev: 1.5 }),
  'too many clocks': (d) => ({ ...d, clocks: new Array(storage.MAX_CLOCKS + 1).fill(d.clocks[0]) }),
  'too many segments': (d) => ({ ...d, segments: new Array(storage.MAX_SEGMENTS + 1).fill(null) }),
  'not an object': () => [],
};

for (const [name, mutate] of Object.entries(REJECTED)) {
  test(`validateBackup rejects: ${name}`, () => {
    const res = storage.validateBackup(mutate(realBackup()));
    assert.equal(res.ok, false);
    assert.equal(typeof res.reason, 'string');
  });
}

test('an accepted backup survives the render-critical core functions', () => {
  const s = storage.normalizeState(realBackup());
  const now = new Date(2026, 4, 4, 12, 0, 0).getTime();
  core.getDaySummaryRows(s, core.dayKey(now), now);
  core.aggregateWeek(s, core.getWeekStart(now), now, s.settings);
  core.descriptionSuggestions(s, s.clocks[0].dossier);
});

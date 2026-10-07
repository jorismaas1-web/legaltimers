import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/storage.js';
import * as core from '../src/core.js';

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

// Runs in Europe/Amsterdam whatever the machine's zone is (see dst.test.js).
process.env.TZ = 'Europe/Amsterdam';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../public/src/core.js');
const { validateBackup } = await import('../public/src/storage.js');

const backup = (segments) => ({
  schemaVersion: 1,
  clocks: [{ id: 'c1', dossier: 'A', createdAt: 0 }],
  segments,
  adjustments: {},
  dayData: {},
  settings: {},
});

test('a segment over the 25-hour DST-end day passes backup validation; one past the day does not', () => {
  const start = new Date(2026, 9, 25, 0, 0).getTime(); // Sunday, 25 hours long
  const end = new Date(2026, 9, 26, 0, 0).getTime();
  assert.equal(end - start, 25 * 3600000);
  assert.equal(validateBackup(backup([{ clockId: 'c1', start, end }])).ok, true);
  assert.equal(validateBackup(backup([{ clockId: 'c1', start, end: end + 1 }])).ok, false);
});

test('the app own split of Sat 20:00 to Mon 09:00 over the DST end re-validates', () => {
  const parts = core.splitSegment({
    clockId: 'c1',
    start: new Date(2026, 9, 24, 20).getTime(),
    end: new Date(2026, 9, 26, 9).getTime(),
  });
  assert.equal(parts.length, 3);
  assert.equal(validateBackup(backup(parts)).ok, true);
});

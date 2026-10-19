// Runs in Europe/Amsterdam whatever the machine's zone is. TZ is set before
// core.js is imported, so every Date it creates uses that zone.
process.env.TZ = 'Europe/Amsterdam';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../public/src/core.js');

test('resolveEndTime picks the repeated 02:45 after the clocks went back', () => {
  // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:15 CET is the second 02:15.
  const startedAt = Date.parse('2026-10-25T01:15:00Z'); // 02:15 CET
  const now = Date.parse('2026-10-25T05:30:00Z'); // 06:30 CET
  const end = core.resolveEndTime(startedAt, '02:45', now);
  assert.equal(end - startedAt, 30 * 60000);
});

test('resolveEndTime still moves to the next day when the time is before the start', () => {
  const startedAt = Date.parse('2026-10-20T13:00:00Z'); // 15:00 CEST
  const now = Date.parse('2026-10-21T13:00:00Z');
  const end = core.resolveEndTime(startedAt, '10:00', now);
  assert.equal(end, Date.parse('2026-10-21T08:00:00Z'));
});

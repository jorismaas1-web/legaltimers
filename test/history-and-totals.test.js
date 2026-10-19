import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../public/src/core.js';

function localMs(y, m, d, h = 0, mi = 0, s = 0) {
  return new Date(y, m - 1, d, h, mi, s, 0).getTime();
}

const MIN = 60000;

function clockWithTime(dossier, t0, minutes) {
  let { state, clockId } = core.addClock(core.createInitialState(), { dossier }, t0);
  state = core.startClock(state, clockId, t0);
  state = core.pauseRunning(state, t0 + minutes * MIN);
  return { state, clockId };
}

// ---- 4: rename keeps history ----

test('renaming a card moves earlier days to an archived card with the old dossier', () => {
  const t0 = localMs(2026, 10, 7, 9, 0);
  let { state, clockId } = clockWithTime('Old / 1', t0, 60);
  state = core.setDescription(state, clockId, '2026-10-07', 'Review');
  state = core.setClockBillable(state, clockId, false, t0);
  const now = localMs(2026, 10, 8, 9, 0);
  state = core.startClock(state, clockId, now);
  state = core.pauseRunning(state, now + 30 * MIN);
  state = core.renameClock(state, clockId, 'New / 2', now + 31 * MIN);

  const yesterday = core.getDaySummaryRows(state, '2026-10-07', now + 31 * MIN);
  assert.equal(yesterday.length, 1);
  assert.equal(yesterday[0].dossier, 'Old / 1');
  assert.equal(yesterday[0].elapsedMs, 60 * MIN);
  assert.equal(yesterday[0].description, 'Review');
  assert.equal(yesterday[0].billable, false);
  const today = core.getDaySummaryRows(state, '2026-10-08', now + 31 * MIN);
  assert.equal(today.length, 1);
  assert.equal(today[0].dossier, 'New / 2');
  assert.equal(today[0].clockId, clockId);
  assert.equal(today[0].elapsedMs, 30 * MIN);
  const archived = state.clocks.find((c) => c.id !== clockId);
  assert.equal(archived.archived, true);
  assert.equal(archived.createdAt, t0);
  assert.equal(state.nextClockSeq, 3);
});

test('renaming the same day, or a card without earlier history, just renames', () => {
  const t0 = localMs(2026, 10, 7, 9, 0);
  const { state, clockId } = clockWithTime('Typo / 1', t0, 30);
  const renamed = core.renameClock(state, clockId, 'Fixed / 1', t0 + 40 * MIN);
  assert.equal(renamed.clocks.length, 1);
  assert.equal(renamed.clocks[0].dossier, 'Fixed / 1');
  assert.equal(core.getDaySummaryRows(renamed, '2026-10-07', t0 + 40 * MIN)[0].dossier, 'Fixed / 1');
  // an empty old dossier is a new card getting its name
  let fresh = core.addClock(state, { dossier: '' }, t0).state;
  fresh = core.renameClock(fresh, 'c2', 'Named', localMs(2026, 10, 9, 9, 0));
  assert.equal(fresh.clocks.length, 2);
});

test('renaming during a run that started before today splits the run at midnight', () => {
  const t0 = localMs(2026, 10, 7, 22, 0);
  let { state, clockId } = core.addClock(core.createInitialState(), { dossier: 'Old' }, t0);
  state = core.startClock(state, clockId, t0);
  const now = localMs(2026, 10, 8, 1, 0);
  state = core.renameClock(state, clockId, 'New', now);
  const midnight = localMs(2026, 10, 8, 0, 0);
  assert.equal(state.running.clockId, clockId);
  assert.equal(state.running.startedAt, midnight);
  const yesterday = core.getDaySummaryRows(state, '2026-10-07', now);
  assert.equal(yesterday[0].dossier, 'Old');
  assert.equal(yesterday[0].elapsedMs, 2 * 3600000);
  const today = core.getDaySummaryRows(state, '2026-10-08', now);
  assert.equal(today[0].dossier, 'New');
  assert.equal(today[0].elapsedMs, 3600000);
});

// ---- 5: manual entry with another billable flag ----

test('a manual entry with the other billable flag lands on its own row', () => {
  const t0 = localMs(2026, 10, 8, 9, 0);
  const { state, clockId } = clockWithTime('Acme / 1', t0, 60);
  const now = localMs(2026, 10, 8, 12, 0);
  const res = core.addManualEntry(state, { dossier: 'Acme / 1', day: '2026-10-08', ms: 10 * MIN, billable: false }, now);
  assert.notEqual(res.clockId, clockId);
  const rows = core.getDaySummaryRows(res.state, '2026-10-08', now);
  assert.equal(rows.length, 2);
  const main = rows.find((r) => r.clockId === clockId);
  assert.equal(main.elapsedMs, 60 * MIN);
  assert.equal(main.billable, true);
  const extra = rows.find((r) => r.clockId === res.clockId);
  assert.equal(extra.elapsedMs, 10 * MIN);
  assert.equal(extra.billable, false);
  assert.equal(extra.dossier, 'Acme / 1');
  // a second non-billable entry adds to that row, not to a third one
  const again = core.addManualEntry(res.state, { dossier: 'Acme / 1', day: '2026-10-08', ms: 5 * MIN, billable: false }, now);
  assert.equal(again.clockId, res.clockId);
  assert.equal(core.getDaySummaryRows(again.state, '2026-10-08', now).length, 2);
});

test('a billable entry next to non-billable time lands on its own row', () => {
  const t0 = localMs(2026, 10, 8, 9, 0);
  let { state, clockId } = clockWithTime('Acme / 1', t0, 60);
  state = core.setDayBillable(state, clockId, '2026-10-08', false);
  const now = localMs(2026, 10, 8, 12, 0);
  const res = core.addManualEntry(state, { dossier: 'Acme / 1', day: '2026-10-08', ms: 20 * MIN, billable: true }, now);
  assert.notEqual(res.clockId, clockId);
  assert.equal(core.isBillable(res.state, clockId, '2026-10-08'), false);
  assert.equal(core.isBillable(res.state, res.clockId, '2026-10-08'), true);
});

test('a manual entry with the same flag still adds to the same row', () => {
  const t0 = localMs(2026, 10, 8, 9, 0);
  const { state, clockId } = clockWithTime('Acme / 1', t0, 60);
  const now = localMs(2026, 10, 8, 12, 0);
  const res = core.addManualEntry(state, { dossier: 'Acme / 1', day: '2026-10-08', ms: 10 * MIN, billable: true }, now);
  assert.equal(res.clockId, clockId);
  assert.equal(core.getDaySummaryRows(res.state, '2026-10-08', now)[0].elapsedMs, 70 * MIN);
});

// ---- 6: Entered means the current amount ----

function enteredFixture(minutes = 80) {
  const t0 = localMs(2026, 10, 8, 9, 0);
  const { state, clockId } = clockWithTime('Acme / 1', t0, minutes);
  const now = localMs(2026, 10, 8, 18, 0);
  return { state, clockId, now };
}

test('ticking Entered stores the amount; unticking clears it', () => {
  let { state, clockId, now } = enteredFixture();
  state = core.setOvergenomen(state, clockId, '2026-10-08', true, 84);
  assert.equal(state.dayData[`${clockId}__2026-10-08`].overgenomenMinutes, 84);
  const row = core.getDaySummaryRows(state, '2026-10-08', now)[0];
  assert.equal(row.overgenomen, true);
  assert.equal(row.enteredMinutes, undefined);
  state = core.setOvergenomen(state, clockId, '2026-10-08', false);
  assert.equal('overgenomenMinutes' in state.dayData[`${clockId}__2026-10-08`], false);
});

test('a row whose amount changed after ticking counts as not entered, with the old amount', () => {
  let { state, clockId, now } = enteredFixture();
  state = core.setOvergenomen(state, clockId, '2026-10-08', true, 84);
  // exact time edit changes the amount (also reopens the row)
  let changed = core.setManualElapsed(state, clockId, '2026-10-08', 100 * MIN, now);
  assert.equal(core.getDaySummaryRows(changed, '2026-10-08', now)[0].overgenomen, false);
  // rounding settings change the amount but nothing reopens the row
  changed = core.updateSettings(state, { roundUnitMinutes: 15 });
  const row = core.getDaySummaryRows(changed, '2026-10-08', now)[0];
  assert.equal(row.overgenomen, false);
  assert.equal(row.enteredMinutes, 84);
  assert.equal(core.weekHasUnprocessed(changed, '2026-10-08', now), true);
  assert.equal(core.weekHasUnprocessed(state, '2026-10-08', now), false);
});

test('billable and description edits do not affect the entered check; legacy marks always count', () => {
  const fx = enteredFixture();
  let state = core.setOvergenomen(fx.state, fx.clockId, '2026-10-08', true, 84);
  state = core.setDayBillable(state, fx.clockId, '2026-10-08', false);
  state = core.setDescription(state, fx.clockId, '2026-10-08', 'new text');
  assert.equal(core.getDaySummaryRows(state, '2026-10-08', fx.now)[0].overgenomen, true);
  const legacy = core.setOvergenomen(fx.state, fx.clockId, '2026-10-08', true);
  assert.equal(legacy.dayData[`${fx.clockId}__2026-10-08`].overgenomenMinutes, undefined);
  const other = core.updateSettings(legacy, { roundUnitMinutes: 15 });
  assert.equal(core.getDaySummaryRows(other, '2026-10-08', fx.now)[0].overgenomen, true);
});

// ---- 10: long-run review ----

test('needsLongRunReview asks again after a kept run goes on', () => {
  const started = localMs(2026, 10, 9, 9, 0);
  const running = { clockId: 'c1', startedAt: started };
  const kept = localMs(2026, 10, 9, 13, 0);
  assert.equal(core.needsLongRunReview(running, undefined, localMs(2026, 10, 9, 10, 0)), false);
  assert.equal(core.needsLongRunReview(running, undefined, localMs(2026, 10, 9, 13, 0)), true);
  assert.equal(core.needsLongRunReview(running, { keptAt: kept }, localMs(2026, 10, 9, 15, 0)), false);
  assert.equal(core.needsLongRunReview(running, { keptAt: kept }, localMs(2026, 10, 9, 16, 30)), true);
  assert.equal(core.needsLongRunReview(running, { keptAt: localMs(2026, 10, 9, 23, 0) }, localMs(2026, 10, 10, 0, 30)), true);
  assert.equal(core.needsLongRunReview(running, 'keep', localMs(2026, 10, 12, 9, 0)), false);
  assert.equal(core.needsLongRunReview(running, { correctedEnd: 1 }, localMs(2026, 10, 9, 14, 0)), true);
  assert.equal(core.needsLongRunReview(null, undefined, kept), false);
});

// ---- 12b: totals equal the sum of what is booked ----

test('decimal totals add up the 2-decimal rows, h:mm totals keep whole minutes', () => {
  const rows = [1, 2, 3].map((i) => ({ clockId: `c${i}`, elapsedMs: 5 * MIN, billable: true }));
  const dec = core.daySplit(rows, { roundUnitMinutes: 5, roundMode: 'up', hoursFormat: 'decimal' });
  assert.equal(dec.total, 0.24);
  assert.equal(dec.billable, 0.24);
  assert.equal(dec.nonBillable, 0);
  const hm = core.daySplit(rows, { roundUnitMinutes: 5, roundMode: 'up', hoursFormat: 'hm' });
  assert.equal(hm.total, 15 / 60);
});

test('week totals follow the same rule', () => {
  const t0 = localMs(2026, 10, 5, 9, 0);
  let state = core.createInitialState();
  for (const name of ['A', 'B', 'C']) {
    const res = core.addClock(state, { dossier: name }, t0);
    state = core.setManualElapsed(res.state, res.clockId, '2026-10-05', 5 * MIN, t0);
  }
  const base = { roundUnitMinutes: 5, roundMode: 'up' };
  const dec = core.aggregateWeek(state, core.getWeekStart(t0), t0, { ...base, hoursFormat: 'decimal' });
  assert.equal(dec.dayTotals[0], 0.24);
  assert.equal(dec.weekTotal, 0.24);
  assert.equal(dec.billableWeekTotal, 0.24);
  const hm = core.aggregateWeek(state, core.getWeekStart(t0), t0, { ...base, hoursFormat: 'hm' });
  assert.equal(hm.weekTotal, 15 / 60);
});

// ---- 16: TSV formulas ----

test('TSV text cells that look like formulas get a leading apostrophe', () => {
  const tsv = core.buildDayTSV(
    [
      { date: '2026-10-08', project: '=1+1', dossier: '+31 20', hours: '-1.5', description: '@cmd', billable: '-x' },
      { date: '2026-10-08', project: '-5', dossier: '- note', hours: '1.5', description: '-SUM(A1)', billable: 'ja' },
    ],
    { project: '=proj' },
  );
  const [head, a, b] = tsv.split('\n').map((l) => l.split('\t'));
  assert.equal(head[1], "'=proj");
  assert.deepEqual(a, ['2026-10-08', "'=1+1", "'+31 20", '-1.5', "'@cmd", "'-x"]);
  assert.deepEqual(b, ['2026-10-08', '-5', '- note', '1.5', "'-SUM(A1)", 'ja']);
});

// ---- 18: time input bounds ----

test('parseTimeInput rejects non-finite and absurd values', () => {
  assert.equal(core.parseTimeInput('9'.repeat(400)), null);
  assert.equal(core.parseTimeInput(`${'9'.repeat(400)}:00`), null);
  assert.equal(core.parseTimeInput('24'), 24 * 3600000);
  assert.equal(core.parseTimeInput('24:00'), 24 * 3600000);
  assert.equal(core.parseTimeInput('24:01'), null);
  assert.equal(core.parseTimeInput('25'), null);
  assert.equal(core.parseTimeInput('37,5', 168), 37.5 * 3600000);
  assert.equal(core.parseTimeInput('169', 168), null);
});

// ---- 19: cleanup and a running clock ----

test('pruneOlderThan moves the start of an old run to the cutoff', () => {
  const t0 = localMs(2026, 8, 3, 9, 0);
  let { state, clockId } = core.addClock(core.createInitialState(), { dossier: 'A' }, t0);
  state = core.startClock(state, clockId, t0);
  const now = localMs(2026, 10, 7, 12, 0);
  const pruned = core.pruneOlderThan(state, 4, now);
  const cutoff = core.addDays(core.startOfLocalDay(now), -28);
  assert.equal(pruned.running.startedAt, cutoff);
  const paused = core.pauseRunning(pruned, now);
  assert.ok(paused.segments.every((s) => s.start >= cutoff));
});

test('resolveDayRowOwner follows a day row that a rename moved to an archived clock', () => {
  const t0 = localMs(2026, 10, 7, 9, 0);
  let { state, clockId } = clockWithTime('Alpha 1', t0, 45);
  const now = localMs(2026, 10, 8, 9, 0);
  // Row still owned by the clock: unchanged.
  assert.equal(core.resolveDayRowOwner(state, clockId, '2026-10-07', 'Alpha 1', now), clockId);
  state = core.renameClock(state, clockId, 'Alpha 2', now);
  const archived = state.clocks.find((c) => c.archived);
  // The remembered id lost its row for that day; the archived clock holds it.
  assert.equal(core.resolveDayRowOwner(state, clockId, '2026-10-07', 'Alpha 1', now), archived.id);
  // No matching row: keep the remembered id.
  assert.equal(core.resolveDayRowOwner(state, clockId, '2026-10-07', 'Other', now), clockId);
  // Two rows with the same dossier: ambiguous, keep the remembered id.
  const twin = clockWithTime('Alpha 1', t0, 30);
  const both = {
    ...state,
    clocks: [...state.clocks, { ...twin.state.clocks[0], id: 'c99' }],
    segments: [...state.segments, ...twin.state.segments.map((s) => ({ ...s, clockId: 'c99' }))],
  };
  assert.equal(core.resolveDayRowOwner(both, clockId, '2026-10-07', 'Alpha 1', now), clockId);
});

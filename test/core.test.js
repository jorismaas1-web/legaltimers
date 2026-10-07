import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.js';

function localMs(y, m, d, h = 0, mi = 0, s = 0) {
  return new Date(y, m - 1, d, h, mi, s, 0).getTime();
}

// ---- chess-clock rule ----

test('starting clock B pauses running clock A, at most one running', () => {
  let state = core.createInitialState();
  const t0 = localMs(2026, 10, 7, 9, 0, 0);
  let res = core.addClock(state, { dossier: 'A' }, t0);
  state = res.state;
  const idA = res.clockId;
  res = core.addClock(state, { dossier: 'B' }, t0);
  state = res.state;
  const idB = res.clockId;

  state = core.startClock(state, idA, t0);
  assert.equal(state.running.clockId, idA);

  const t1 = localMs(2026, 10, 7, 9, 10, 0);
  state = core.startClock(state, idB, t1);
  assert.equal(state.running.clockId, idB);
  // A must now have a finalized segment from t0 to t1
  const segA = state.segments.filter((s) => s.clockId === idA);
  assert.equal(segA.length, 1);
  assert.equal(segA[0].start, t0);
  assert.equal(segA[0].end, t1);

  const t2 = localMs(2026, 10, 7, 9, 20, 0);
  state = core.pauseRunning(state, t2);
  assert.equal(state.running, null);
  const segB = state.segments.filter((s) => s.clockId === idB);
  assert.equal(segB.length, 1);
  assert.equal(segB[0].end - segB[0].start, t2 - t1);
});

// ---- elapsed time across simulated sleep ----

test('elapsed time for running clock = accumulated + (now - startedAt), surviving a sleep gap', () => {
  let state = core.createInitialState();
  const t0 = localMs(2026, 10, 7, 9, 0, 0);
  let res = core.addClock(state, { dossier: 'A' }, t0);
  state = res.state;
  const id = res.clockId;
  state = core.startClock(state, id, t0);

  // simulate laptop sleeping for 2 hours; "now" jumps forward without ticks
  const now = localMs(2026, 10, 7, 11, 0, 0);
  const day = core.dayKey(t0);
  const elapsed = core.elapsedForDay(state, id, day, now);
  assert.equal(elapsed, now - t0);
});

// ---- segment split at local midnight ----

test('a running segment crossing local midnight is split into two day segments', () => {
  const start = localMs(2026, 10, 7, 23, 30, 0);
  const end = localMs(2026, 10, 8, 1, 15, 0);
  const parts = core.splitSegment({ clockId: 'x', start, end });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].start, start);
  assert.equal(parts[0].end, localMs(2026, 10, 8, 0, 0, 0));
  assert.equal(parts[1].start, localMs(2026, 10, 8, 0, 0, 0));
  assert.equal(parts[1].end, end);

  // and elapsedForDay attributes the right share to each day
  let state = core.createInitialState();
  let res = core.addClock(state, { dossier: 'A' }, start);
  state = res.state;
  const id = res.clockId;
  state = core.startClock(state, id, start);
  state = core.pauseRunning(state, end);

  const day1 = core.dayKey(start);
  const day2 = core.dayKey(end);
  assert.equal(core.elapsedForDay(state, id, day1, end), localMs(2026, 10, 8, 0, 0, 0) - start);
  assert.equal(core.elapsedForDay(state, id, day2, end), end - localMs(2026, 10, 8, 0, 0, 0));
});

// ---- manual time edit adjustment ----

test('manual time edit sets an adjustment so the day total equals the entered value', () => {
  let state = core.createInitialState();
  const t0 = localMs(2026, 10, 7, 9, 0, 0);
  let res = core.addClock(state, { dossier: 'A' }, t0);
  state = res.state;
  const id = res.clockId;
  state = core.startClock(state, id, t0);
  const t1 = localMs(2026, 10, 7, 9, 10, 0); // 10 min logged
  state = core.pauseRunning(state, t1);

  const day = core.dayKey(t0);
  const targetMs = 2 * 60 * 60 * 1000; // user corrects to 2h
  state = core.setManualElapsed(state, id, day, targetMs, t1);
  assert.equal(core.elapsedForDay(state, id, day, t1), targetMs);

  // editing again to a smaller value also works (adjustment can be negative)
  state = core.setManualElapsed(state, id, day, 5 * 60 * 1000, t1);
  assert.equal(core.elapsedForDay(state, id, day, t1), 5 * 60 * 1000);
});

// ---- 6-minute round-up table ----

test('6-minute round-up table', () => {
  const cases = [
    [0, 0],
    [1000, 0.1],
    [6 * 60 * 1000, 0.1],
    [6 * 60 * 1000 + 1000, 0.2],
    [(1 * 3600 + 40 * 60 + 56) * 1000, 1.7],
  ];
  for (const [ms, expected] of cases) {
    assert.equal(core.roundHoursMs(ms, 6, 'up'), expected, `ms=${ms}`);
  }
});

// ---- nearest mode ----

test('nearest rounding mode rounds to the closest unit', () => {
  // 6-min units: 2 min -> nearest is 0 units (0h); 4 min -> nearest is 1 unit (0.1h)
  assert.equal(core.roundHoursMs(2 * 60 * 1000, 6, 'nearest'), 0);
  assert.equal(core.roundHoursMs(4 * 60 * 1000, 6, 'nearest'), 0.1);
  assert.equal(core.roundHoursMs(3 * 60 * 1000, 6, 'nearest'), 0.1); // half rounds up
});

// ---- other units ----

test('other rounding units (1/5/10/15 min)', () => {
  assert.equal(core.roundHoursMs(30 * 1000, 1, 'up'), round2(1 / 60));
  assert.equal(core.roundHoursMs(1 * 60 * 1000, 5, 'up'), round2(5 / 60));
  assert.equal(core.roundHoursMs(1 * 60 * 1000, 10, 'up'), round2(10 / 60));
  assert.equal(core.roundHoursMs(1 * 60 * 1000, 15, 'up'), round2(15 / 60));
  function round2(x) {
    return Math.round((x + 1e-9) * 100) / 100;
  }
});

// ---- h:mm formatting ----

test('formatHM formats decimal hours as h:mm', () => {
  assert.equal(core.formatHM(1.7), '1:42');
  assert.equal(core.formatHM(0.1), '0:06');
  assert.equal(core.formatHM(2), '2:00');
});

test('formatDecimalHours formats without trailing noise', () => {
  assert.equal(core.formatDecimalHours(1.7), '1.7');
  assert.equal(core.formatDecimalHours(0), '0');
  assert.equal(core.formatDecimalHours(2), '2');
  assert.equal(core.formatDecimalHours(1.25), '1.25');
});

test('formatHMS formats milliseconds as h:mm:ss', () => {
  assert.equal(core.formatHMS(0), '0:00:00');
  assert.equal(core.formatHMS((1 * 3600 + 40 * 60 + 56) * 1000), '1:40:56');
});

// ---- time-input parsing ----

test('parseTimeInput parses h:mm, h:mm:ss and decimal hours', () => {
  assert.equal(core.parseTimeInput('1:30'), 90 * 60 * 1000);
  assert.equal(core.parseTimeInput('1:30:15'), (90 * 60 + 15) * 1000);
  assert.equal(core.parseTimeInput('1.5'), 90 * 60 * 1000);
  assert.equal(core.parseTimeInput('0.1'), 6 * 60 * 1000);
  assert.equal(core.parseTimeInput(''), null);
  assert.equal(core.parseTimeInput('abc'), null);
});

// ---- week aggregation Mon-Sun ----

test('aggregateWeek buckets by Mon-Sun and totals per day and per week', () => {
  let state = core.createInitialState();
  // Wednesday 2026-10-07
  const wed = localMs(2026, 10, 7, 9, 0, 0);
  let res = core.addClock(state, { dossier: 'A' }, wed);
  state = res.state;
  const id = res.clockId;

  state = core.startClock(state, id, wed);
  const wedEnd = localMs(2026, 10, 7, 11, 0, 0); // 2h on Wednesday
  state = core.pauseRunning(state, wedEnd);

  const fri = localMs(2026, 10, 9, 9, 0, 0);
  state = core.startClock(state, id, fri);
  const friEnd = localMs(2026, 10, 9, 10, 0, 0); // 1h on Friday
  state = core.pauseRunning(state, friEnd);

  const weekStart = core.getWeekStart(wed);
  assert.equal(core.dayKey(weekStart), '2026-10-05'); // Monday

  const agg = core.aggregateWeek(state, weekStart, friEnd, { roundUnitMinutes: 6, roundMode: 'up' });
  assert.equal(agg.rows.length, 1);
  const row = agg.rows[0];
  // Wed is index 2 (Mon=0), Fri is index 4
  assert.equal(row.hours[2], 2);
  assert.equal(row.hours[4], 1);
  assert.equal(row.total, 3);
  assert.equal(agg.dayTotals[2], 2);
  assert.equal(agg.dayTotals[4], 1);
  assert.equal(agg.weekTotal, 3);
});

// ---- dossier-number extraction ----

test('extractDossierNumber takes the last "/"-separated numeric part, else the full line', () => {
  assert.equal(core.extractDossierNumber('Client BV / Matter / 2002100001'), '2002100001');
  assert.equal(core.extractDossierNumber('Client BV / Matter / Appendix A'), 'Client BV / Matter / Appendix A');
  assert.equal(core.extractDossierNumber('just a dossier'), 'just a dossier');
  assert.equal(core.extractDossierNumber('2002100001'), '2002100001');
});

// ---- TSV output ----

test('buildDayTSV produces header + rows separated by tabs and newlines', () => {
  const tsv = core.buildDayTSV([
    { date: '2026-10-07', dossier: '2002100001', hours: '1.7', description: 'memo' },
  ]);
  const lines = tsv.split('\n');
  assert.equal(lines[0], 'date\tdossier\thours\tdescription');
  assert.equal(lines[1], '2026-10-07\t2002100001\t1.7\tmemo');
});

// ---- long-run detection ----

test('isLongRun flags runs over 3 hours or that crossed midnight', () => {
  const start = localMs(2026, 10, 7, 9, 0, 0);
  assert.equal(core.isLongRun(start, localMs(2026, 10, 7, 11, 0, 0)), false);
  assert.equal(core.isLongRun(start, localMs(2026, 10, 7, 12, 30, 0)), true); // > 3h
  assert.equal(core.isLongRun(start, localMs(2026, 10, 8, 0, 30, 0)), true); // past midnight, < 3h
});

// ---- removing a timer keeps its history ----

test('removeClock archives the card but keeps past hours for day and week views', () => {
  let state = core.createInitialState();
  const mon = localMs(2026, 10, 5, 9, 0, 0);
  const res = core.addClock(state, { dossier: 'A / 1' }, mon);
  state = res.state;
  const id = res.clockId;
  state = core.startClock(state, id, mon);
  const thu = localMs(2026, 10, 8, 10, 0, 0);
  state = core.pauseRunning(state, localMs(2026, 10, 5, 10, 0, 0));
  state = core.startClock(state, id, thu);

  state = core.removeClock(state, id, localMs(2026, 10, 8, 10, 30, 0));

  assert.equal(state.running, null, 'running clock is paused on removal');
  assert.deepEqual(core.activeClocks(state).map((c) => c.id), []);
  assert.equal(core.elapsedForDay(state, id, core.dayKey(mon), thu), 3600000);
  assert.equal(core.elapsedForDay(state, id, core.dayKey(thu), thu + 3600000), 1800000);
});

test('pruneOlderThan drops archived clocks that have no history left', () => {
  let state = core.createInitialState();
  const old = localMs(2026, 1, 5, 9, 0, 0);
  const res = core.addClock(state, { dossier: 'Old' }, old);
  state = core.startClock(res.state, res.clockId, old);
  state = core.pauseRunning(state, old + 600000);
  state = core.removeClock(state, res.clockId, old + 600000);
  const keep = core.addClock(state, { dossier: 'Keep' }, old);
  state = core.pruneOlderThan(keep.state, 4, localMs(2026, 10, 7, 12, 0, 0));
  assert.deepEqual(state.clocks.map((c) => c.dossier), ['Keep']);
});

// ---- AFAS-friendly copy values ----

test('formatDecimalHours uses the given decimal separator', () => {
  assert.equal(core.formatDecimalHours(1.7, ','), '1,7');
  assert.equal(core.formatDecimalHours(2, ','), '2');
  assert.equal(core.formatDecimalHours(1.25), '1.25');
});

test('parseTimeInput accepts a decimal comma (NL input)', () => {
  assert.equal(core.parseTimeInput('1,5'), 1.5 * 3600 * 1000);
  assert.equal(core.parseTimeInput('0,25'), 0.25 * 3600 * 1000);
  assert.equal(core.parseTimeInput('1,2,3'), null);
});

test('resolveEndTime turns a clock time into an end timestamp after the start, clamped to now', () => {
  const start = localMs(2026, 10, 7, 9, 0, 0);
  const now = localMs(2026, 10, 7, 23, 0, 0);
  assert.equal(core.resolveEndTime(start, '17:30', now), localMs(2026, 10, 7, 17, 30, 0));
  assert.equal(core.resolveEndTime(start, '17.30', now), localMs(2026, 10, 7, 17, 30, 0));
  // later than now: clamp
  assert.equal(core.resolveEndTime(start, '23:30', now), now);
  // ran past midnight: an end time before the start time means the next day
  const now2 = localMs(2026, 10, 8, 10, 0, 0);
  const start2 = localMs(2026, 10, 7, 22, 0, 0);
  assert.equal(core.resolveEndTime(start2, '0:30', now2), localMs(2026, 10, 8, 0, 30, 0));
  assert.equal(core.resolveEndTime(start, 'nonsense', now), null);
  assert.equal(core.resolveEndTime(start, '25:00', now), null);
});

test('starting a clock again clears its Gereed mark for today', () => {
  const t0 = localMs(2026, 10, 7, 9, 0, 0);
  let { state, clockId } = core.addClock(core.createInitialState(), { dossier: 'A' }, t0);
  state = core.startClock(state, clockId, t0);
  state = core.markReady(state, clockId, '2026-10-07', localMs(2026, 10, 7, 10, 0, 0));
  assert.equal(core.getDaySummaryRows(state, '2026-10-07', t0 + 3600000)[0].ready, true);
  state = core.startClock(state, clockId, localMs(2026, 10, 7, 11, 0, 0));
  assert.equal(core.getDaySummaryRows(state, '2026-10-07', localMs(2026, 10, 7, 11, 5, 0))[0].ready, false);
});

test('buildDayTSV replaces tabs and newlines inside fields with spaces', () => {
  const tsv = core.buildDayTSV([{ date: '2026-10-07', dossier: 'A\tB', hours: '0,2', description: 'line1\nline2' }]);
  assert.equal(tsv.split('\n')[1], '2026-10-07\tA B\t0,2\tline1 line2');
});

test('isReady reports the Gereed mark for a clock on a day', () => {
  const t0 = localMs(2026, 10, 7, 9, 0, 0);
  let { state, clockId } = core.addClock(core.createInitialState(), { dossier: 'A' }, t0);
  assert.equal(core.isReady(state, clockId, '2026-10-07'), false);
  state = core.markReady(state, clockId, '2026-10-07', t0);
  assert.equal(core.isReady(state, clockId, '2026-10-07'), true);
  assert.equal(core.isReady(state, clockId, '2026-10-08'), false);
});

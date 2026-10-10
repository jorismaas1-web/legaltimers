import * as core from './core.js';
import { createStorage, validateBackupShape, normalizeState, STORAGE_KEY } from './storage.js';
import { detectLanguage, translate } from './i18n.js';

// Reading window.localStorage itself throws when the browser blocks site
// data; fall back to a backend that fails every call so the app still runs
// and the storage warning shows.
function storageBackend() {
  try {
    return window.localStorage;
  } catch (e) {
    return {
      getItem() {
        throw e;
      },
      setItem() {
        throw e;
      },
    };
  }
}

const store = createStorage(storageBackend());
let state = withLanguage(store.load());

let focusNewDossierFor = null;
let weekCursor = core.getWeekStart(Date.now());
let dayCursor = null; // null = today
const cardEls = new Map();

function withLanguage(s) {
  if (s.settings.language) return s;
  return core.updateSettings(s, { language: detectLanguage(navigator.language) });
}

function t(key, vars) {
  let text = translate(state.settings.language, key);
  for (const [name, value] of Object.entries(vars || {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

function decimalSeparator() {
  return state.settings.language === 'nl' ? ',' : '.';
}

function persist() {
  const ok = store.save(state);
  document.getElementById('storage-warning').hidden = ok;
}

// Another tab with this page saved: take over its state so the tabs do not
// overwrite each other's time.
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY) return;
  state = withLanguage(store.load());
  rerenderAll();
});

function rerenderAll() {
  applyI18n();
  renderDossierHistory();
  renderCards();
  renderDay();
  renderWeek();
  renderSettings();
}

function now() {
  return Date.now();
}

function today() {
  return core.dayKey(now());
}

// ---------- i18n ----------

function applyI18n() {
  document.documentElement.lang = state.settings.language;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  document.getElementById('lang-toggle').textContent = state.settings.language.toUpperCase();
}

// ---------- tabs ----------

function setActiveTab(tab) {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('is-active', view.id === `view-${tab}`);
  }
  if (tab === 'day') renderDay();
  if (tab === 'week') renderWeek();
  if (tab === 'settings') renderSettings();
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  if (btn.dataset.tab === 'day') dayCursor = null;
  setActiveTab(btn.dataset.tab);
});

// ---------- confirm dialog ----------

function showConfirm(message, onConfirm, okLabel = t('delete')) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-message').textContent = message;
  dialog.hidden = false;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = okLabel;
  ok.focus();
  function cleanup() {
    dialog.hidden = true;
    ok.removeEventListener('click', onOk);
    cancel.removeEventListener('click', onCancel);
  }
  function onOk() {
    cleanup();
    onConfirm();
  }
  function onCancel() {
    cleanup();
  }
  ok.addEventListener('click', onOk);
  cancel.addEventListener('click', onCancel);
}

// ---------- cards (Timers view) ----------

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function createCardElement(clock) {
  const template = document.getElementById('card-template');
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.clockId = clock.id;

  const dossierInput = node.querySelector('.card-dossier');
  const descInput = node.querySelector('.card-description');
  const descList = node.querySelector('.card-description-suggestions');
  const timeInput = node.querySelector('.card-time');
  const startPauseBtn = node.querySelector('.card-startpause');
  const readyBtn = node.querySelector('.card-ready');
  const billableBtn = node.querySelector('.card-billable');
  const deleteBtn = node.querySelector('.card-delete');

  dossierInput.placeholder = t('dossierPlaceholder');
  dossierInput.value = clock.dossier;
  descList.id = `desc-suggestions-${clock.id}`;
  descInput.setAttribute('list', descList.id);

  dossierInput.addEventListener('change', () => {
    state = core.updateClock(state, clock.id, { dossier: dossierInput.value });
    state = core.recordDossierUsed(state, dossierInput.value);
    state = core.adoptBillableFromDossier(state, clock.id, now());
    persist();
    renderDossierHistory();
    renderCards();
  });
  // The card's description is today's description, the same text the day
  // summary shows and copies into AFAS. It is saved to the day typing
  // started on, so text begun before midnight stays on that day.
  descInput.addEventListener('focus', () => {
    descInput.dataset.day = today();
    fillSuggestions(descList, dossierInput.value);
  });
  descInput.addEventListener('change', () => {
    state = core.setDescription(state, clock.id, descInput.dataset.day || today(), descInput.value);
    persist();
  });
  billableBtn.addEventListener('click', () => {
    state = core.setClockBillable(state, clock.id, !core.isBillable(state, clock.id, today()), now());
    persist();
    renderCards();
  });
  timeInput.addEventListener('change', () => {
    const ms = core.parseTimeInput(timeInput.value);
    if (ms === null) {
      timeInput.value = core.formatHMS(core.elapsedForDay(state, clock.id, today(), now()));
      return;
    }
    state = core.setManualElapsed(state, clock.id, today(), ms, now());
    persist();
    tick();
  });
  startPauseBtn.addEventListener('click', () => toggleStartPause(clock.id));
  readyBtn.addEventListener('click', () => {
    state = core.markReady(state, clock.id, today(), now());
    persist();
    renderCards();
  });
  deleteBtn.addEventListener('click', () => {
    showConfirm(t('confirmDeleteTimer'), () => {
      state = core.removeClock(state, clock.id, now());
      persist();
      renderCards();
    });
  });

  cardEls.set(clock.id, { node, dossierInput, descInput, descList, timeInput, startPauseBtn, readyBtn, billableBtn, deleteBtn });
  return node;
}

function toggleStartPause(clockId) {
  if (state.running && state.running.clockId === clockId) {
    state = core.pauseRunning(state, now());
  } else {
    state = core.startClock(state, clockId, now());
  }
  persist();
  renderCards();
}

function renderCards() {
  const grid = document.getElementById('cards-grid');
  const seen = new Set();

  const day = today();
  for (const clock of core.activeClocks(state)) {
    seen.add(clock.id);
    let entry = cardEls.get(clock.id);
    if (!entry) {
      const node = createCardElement(clock);
      grid.appendChild(node);
      entry = cardEls.get(clock.id);
    } else if (!grid.contains(entry.node)) {
      grid.appendChild(entry.node);
    }
    const running = !!(state.running && state.running.clockId === clock.id);
    const ready = !running && core.isReady(state, clock.id, day);
    const billable = core.isBillable(state, clock.id, day);
    if (document.activeElement !== entry.dossierInput) entry.dossierInput.value = clock.dossier;
    entry.dossierInput.placeholder = t('dossierPlaceholder');
    entry.descInput.placeholder = t('descriptionPlaceholder');
    syncCardDescription(entry, clock.id, day);
    entry.node.classList.toggle('is-running', running);
    entry.node.classList.toggle('is-ready', ready);
    entry.node.classList.toggle('is-nonbillable', !billable);
    entry.startPauseBtn.textContent = running ? t('pause') : t('start');
    entry.readyBtn.textContent = ready ? `${t('ready')} ✓` : t('ready');
    setBillableToggle(entry.billableBtn, billable, t('cardBillableTitle'));
    if (billable !== core.clockBillableDefault(state, clock.id, day)) {
      entry.billableBtn.textContent += ` (${t('todayOnly')})`;
    }
    entry.deleteBtn.setAttribute('aria-label', t('deleteTimer'));
    entry.deleteBtn.title = t('deleteTimer');
  }

  for (const [clockId, entry] of [...cardEls.entries()]) {
    if (!seen.has(clockId)) {
      entry.node.remove();
      cardEls.delete(clockId);
    }
  }

  if (focusNewDossierFor) {
    const entry = cardEls.get(focusNewDossierFor);
    if (entry) entry.dossierInput.focus();
    focusNewDossierFor = null;
  }

  tick();
}

function syncCardDescription(entry, clockId, day) {
  if (document.activeElement === entry.descInput) return;
  const value = core.getDescription(state, clockId, day);
  if (entry.descInput.value !== value) entry.descInput.value = value;
}

function fillSuggestions(list, dossier) {
  list.innerHTML = '';
  for (const text of core.descriptionSuggestions(state, dossier)) {
    const opt = document.createElement('option');
    opt.value = text;
    list.appendChild(opt);
  }
}

function setBillableToggle(btn, billable, title) {
  btn.textContent = billable ? t('billable') : t('nonBillable');
  btn.classList.toggle('is-nonbillable', !billable);
  btn.setAttribute('aria-pressed', String(billable));
  btn.title = title;
}

function renderDossierHistory() {
  const list = document.getElementById('dossier-history');
  list.innerHTML = '';
  for (const d of state.dossierHistory) {
    const opt = document.createElement('option');
    opt.value = d;
    list.appendChild(opt);
  }
}

document.getElementById('new-timer-btn').addEventListener('click', () => {
  const res = core.addClock(state, { dossier: '' }, now());
  state = res.state;
  focusNewDossierFor = res.clockId;
  persist();
  renderCards();
});

document.getElementById('pause-all-btn').addEventListener('click', () => {
  state = core.pauseAll(state, now());
  persist();
  renderCards();
});

// ---------- long-run banner ----------

function longRunKey(clockId, startedAt) {
  return `${clockId}__${startedAt}`;
}

function updateLongRunBanner() {
  const banner = document.getElementById('long-run-banner');
  if (!state.running) {
    banner.hidden = true;
    return;
  }
  const { clockId, startedAt } = state.running;
  const key = longRunKey(clockId, startedAt);
  if (core.isLongRun(startedAt, now()) && state.longRunDecisions[key] !== 'keep') {
    const clock = state.clocks.find((c) => c.id === clockId);
    document.getElementById('long-run-dossier').textContent = clock && clock.dossier ? `(${clock.dossier})` : '';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

document.getElementById('long-run-keep').addEventListener('click', () => {
  if (!state.running) return;
  const key = longRunKey(state.running.clockId, state.running.startedAt);
  state = { ...state, longRunDecisions: { ...state.longRunDecisions, [key]: 'keep' } };
  persist();
  updateLongRunBanner();
});

document.getElementById('long-run-correct').addEventListener('click', () => {
  if (!state.running) return;
  const started = new Date(state.running.startedAt);
  const startedLabel = `${started.getHours()}:${String(started.getMinutes()).padStart(2, '0')}`;
  const answer = window.prompt(t('longRunCorrectPrompt', { start: startedLabel }), '');
  if (answer === null) return;
  const correctedEnd = core.resolveEndTime(state.running.startedAt, answer, now());
  if (correctedEnd === null) {
    window.alert(t('longRunCorrectInvalid'));
    return;
  }
  state = core.pauseRunning(state, correctedEnd);
  persist();
  renderCards();
});

// ---------- tick (live display) ----------

let lastTickDay = null;

function tick() {
  const day = today();
  const n = now();

  // Past midnight with the page open: cards, day and week show the new day.
  if (lastTickDay !== null && lastTickDay !== day) {
    lastTickDay = day;
    dayCursor = null;
    renderCards();
    renderDay();
    renderWeek();
    return;
  }
  lastTickDay = day;

  const byClock = core.elapsedByClock(state, day, n);
  for (const clock of core.activeClocks(state)) {
    const entry = cardEls.get(clock.id);
    if (!entry) continue;
    if (document.activeElement !== entry.timeInput) {
      entry.timeInput.value = core.formatHMS(byClock.get(clock.id) || 0);
    }
    syncCardDescription(entry, clock.id, day);
  }

  const rows = core.getDaySummaryRows(state, day, n);
  document.getElementById('header-today-total').textContent = core.formatHMS(rows.reduce((a, r) => a + r.elapsedMs, 0));
  const split = core.daySplit(rows, state.settings);
  document.getElementById('header-billable-split').textContent =
    split.total > 0
      ? t('headerSplit', {
          total: formatHoursForDisplay(split.total),
          billable: formatHoursForDisplay(split.billable),
          nonBillable: formatHoursForDisplay(split.nonBillable),
        })
      : '';

  if (state.running) {
    const clock = state.clocks.find((c) => c.id === state.running.clockId);
    const elapsedToday = byClock.get(state.running.clockId) || 0;
    const label = core.formatHM(elapsedToday / 3600000);
    document.title = clock && clock.dossier ? `▶ ${label} · ${clock.dossier}` : `▶ ${label}`;
  } else {
    document.title = t('appTitle');
  }

  updateLongRunBanner();

  const dayView = document.getElementById('view-day');
  if (
    state.running &&
    dayView.classList.contains('is-active') &&
    !dayView.contains(document.activeElement) &&
    n - lastDayRender > 15000
  ) {
    renderDay();
  }
}

setInterval(tick, 1000);

// ---------- keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(document.activeElement)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.getElementById('confirm-dialog').hidden) return;
  if (!document.getElementById('view-timers').classList.contains('is-active')) return;
  if (e.key >= '1' && e.key <= '9') {
    const idx = Number(e.key) - 1;
    const clock = core.activeClocks(state)[idx];
    if (clock) toggleStartPause(clock.id);
  } else if (e.key === ' ') {
    e.preventDefault();
    state = core.pauseAll(state, now());
    persist();
    renderCards();
  } else if (e.key === 'n' || e.key === 'N') {
    document.getElementById('new-timer-btn').click();
  }
});

// ---------- Day view ----------

let lastDayRender = 0;

function shownDay() {
  return dayCursor || today();
}

function renderDay() {
  lastDayRender = now();
  const day = shownDay();
  const isToday = day === today();
  const n = now();
  document.getElementById('day-title').textContent = isToday ? t('daySummaryTitle') : `${t('daySummaryFor')} ${formatDayLabel(day)}`;
  document.getElementById('day-next-btn').disabled = isToday;
  const rows = core.getDaySummaryRows(state, day, n);
  const tbody = document.getElementById('day-table-body');
  tbody.innerHTML = '';
  document.getElementById('day-empty').hidden = rows.length > 0;

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.classList.toggle('row-overgenomen', row.overgenomen);
    tr.classList.toggle('row-nonbillable', !row.billable);

    const roundedHours = core.roundHoursMs(row.elapsedMs, state.settings.roundUnitMinutes, state.settings.roundMode);
    const hoursDisplay = formatHoursForDisplay(roundedHours);
    const dossierNumber = core.extractDossierNumber(row.dossier);

    const tdDossier = document.createElement('td');
    tdDossier.append(row.dossier, copyButton(dossierNumber, t('copyDossier')));
    if (row.ready) {
      const badge = document.createElement('span');
      badge.className = 'ready-badge';
      badge.textContent = t('ready');
      tdDossier.append(badge);
    }

    const tdExact = document.createElement('td');
    tdExact.textContent = core.formatHMS(row.elapsedMs);

    const tdHours = document.createElement('td');
    tdHours.append(hoursDisplay, copyButton(hoursDisplay, t('copyHours')));

    const tdDescription = document.createElement('td');
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = row.description;
    descInput.autocomplete = 'off';
    const descList = document.createElement('datalist');
    descList.id = `day-desc-suggestions-${row.clockId}`;
    descInput.setAttribute('list', descList.id);
    descInput.addEventListener('focus', () => fillSuggestions(descList, row.dossier));
    descInput.addEventListener('click', (e) => e.stopPropagation());
    descInput.addEventListener('change', () => {
      state = core.setDescription(state, row.clockId, day, descInput.value);
      persist();
    });
    tdDescription.append(descInput, descList, copyButton(() => descInput.value, t('copyDescription')));

    const tdBillable = document.createElement('td');
    const billableBtn = document.createElement('button');
    billableBtn.type = 'button';
    billableBtn.className = 'billable-toggle';
    setBillableToggle(billableBtn, row.billable, t('dayBillableTitle'));
    billableBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state = core.setDayBillable(state, row.clockId, day, !row.billable);
      persist();
      renderDay();
      renderCards();
    });
    tdBillable.appendChild(billableBtn);

    const tdOvergenomen = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = row.overgenomen;
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      state = core.setOvergenomen(state, row.clockId, day, checkbox.checked);
      persist();
      renderDay();
    });
    tdOvergenomen.appendChild(checkbox);

    tr.append(tdDossier, tdExact, tdHours, tdDescription, tdBillable, tdOvergenomen);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('input, button, a')) return;
      state = core.setOvergenomen(state, row.clockId, day, !row.overgenomen);
      persist();
      renderDay();
    });

    tbody.appendChild(tr);
  }

  renderDayFoot(rows);
}

function renderDayFoot(rows) {
  const tfoot = document.getElementById('day-table-foot');
  tfoot.innerHTML = '';
  if (rows.length === 0) return;
  const split = core.daySplit(rows, state.settings);
  const share = core.billableShare(split.billable, split.total);
  const tr = document.createElement('tr');
  const label = document.createElement('td');
  label.textContent = t('weekTotalRow');
  const exact = document.createElement('td');
  exact.textContent = core.formatHMS(rows.reduce((a, r) => a + r.elapsedMs, 0));
  const hours = document.createElement('td');
  hours.textContent = formatHoursForDisplay(split.total);
  const detail = document.createElement('td');
  detail.colSpan = 3;
  detail.textContent = t(share === null ? 'daySplitLine' : 'daySplitLineShare', {
    billable: formatHoursForDisplay(split.billable),
    nonBillable: formatHoursForDisplay(split.nonBillable),
    pct: share,
  });
  tr.append(label, exact, hours, detail);
  tfoot.appendChild(tr);
}

function copyButton(valueOrFn, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cell-copy-btn';
  btn.textContent = '⎘';
  btn.title = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const value = typeof valueOrFn === 'function' ? valueOrFn() : valueOrFn;
    copyToClipboard(value, btn);
  });
  return btn;
}

// Copies and briefly shows a check mark (or a cross if the browser refused)
// on the button that was clicked.
function copyToClipboard(text, btn) {
  const flash = (ok) => {
    if (!btn) return;
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = ok ? (btn.classList.contains('cell-copy-btn') ? '✓' : `✓ ${t('copied')}`) : '✗';
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.textContent = original;
      delete btn.dataset.label;
    }, 1200);
  };
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    flash(false);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => flash(true),
    () => flash(false),
  );
}

function formatDayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(state.settings.language === 'nl' ? 'nl-NL' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function shiftDay(n) {
  const [y, m, d] = shownDay().split('-').map(Number);
  const next = core.dayKey(core.addDays(new Date(y, m - 1, d).getTime(), n));
  dayCursor = next >= today() ? null : next;
  renderDay();
}

document.getElementById('day-prev-btn').addEventListener('click', () => shiftDay(-1));
document.getElementById('day-next-btn').addEventListener('click', () => shiftDay(1));
document.getElementById('day-today-btn').addEventListener('click', () => {
  dayCursor = null;
  renderDay();
});

document.getElementById('copy-day-table-btn').addEventListener('click', (e) => {
  const day = shownDay();
  const n = now();
  const rows = core.getDaySummaryRows(state, day, n).map((row) => {
    const roundedHours = core.roundHoursMs(row.elapsedMs, state.settings.roundUnitMinutes, state.settings.roundMode);
    const hoursDisplay = formatHoursForDisplay(roundedHours);
    return {
      date: day,
      project: core.extractDossierNumber(row.dossier),
      dossier: row.dossier,
      hours: hoursDisplay,
      description: row.description,
      billable: row.billable ? t('yes') : t('no'),
    };
  });
  const header = Object.fromEntries(core.TSV_COLUMNS.map((c) => [c, t(`tsv_${c}`)]));
  copyToClipboard(core.buildDayTSV(rows, header), e.currentTarget);
});

// ---------- Week view ----------

const WEEKDAY_LABELS_NL = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
const WEEKDAY_LABELS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderWeek() {
  const n = now();
  const agg = core.aggregateWeek(state, weekCursor, n, {
    roundUnitMinutes: state.settings.roundUnitMinutes,
    roundMode: state.settings.roundMode,
  });
  const labels = state.settings.language === 'nl' ? WEEKDAY_LABELS_NL : WEEKDAY_LABELS_EN;

  const rangeEnd = core.addDays(weekCursor, 6);
  document.getElementById('week-range-label').textContent = `${agg.days[0]} – ${core.dayKey(rangeEnd)}`;

  const thead = document.getElementById('week-table-head');
  thead.innerHTML = '';
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  headRow.children[0].textContent = t('colDossier');
  agg.days.forEach((day, i) => {
    const th = document.createElement('th');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'week-day-btn';
    const [, m, d] = day.split('-').map(Number);
    btn.textContent = `${labels[i]} ${d}/${m}`;
    btn.title = `${t('openDay')}: ${formatDayLabel(day)}`;
    btn.addEventListener('click', () => {
      dayCursor = day >= today() ? null : day;
      setActiveTab('day');
    });
    th.appendChild(btn);
    if (core.weekHasUnprocessed(state, day, n)) {
      btn.classList.add('week-day-dot');
      const note = document.createElement('span');
      note.className = 'visually-hidden';
      note.textContent = t('notYetOvergenomen');
      btn.appendChild(note);
    }
    headRow.appendChild(th);
  });
  const thTotal = document.createElement('th');
  thTotal.textContent = t('weekTotalRow');
  headRow.appendChild(thTotal);
  thead.appendChild(headRow);

  const tbody = document.getElementById('week-table-body');
  tbody.innerHTML = '';
  for (const row of agg.rows) {
    const tr = document.createElement('tr');
    const tdDossier = document.createElement('td');
    tdDossier.textContent = row.dossier;
    tr.appendChild(tdDossier);
    row.hours.forEach((h, i) => {
      const td = document.createElement('td');
      td.textContent = h > 0 ? formatHoursForDisplay(h) : '';
      if (h > 0 && !row.billable[i]) {
        td.classList.add('cell-nonbillable');
        td.title = t('nonBillable');
      }
      tr.appendChild(td);
    });
    const tdTotal = document.createElement('td');
    tdTotal.textContent = formatHoursForDisplay(row.total);
    tr.appendChild(tdTotal);
    tbody.appendChild(tr);
  }

  const tfoot = document.getElementById('week-table-foot');
  tfoot.innerHTML = '';
  const footRows = [
    [t('weekTotalRow'), agg.dayTotals, agg.weekTotal, 'week-foot-total'],
    [t('billable'), agg.billableDayTotals, agg.billableWeekTotal, 'week-foot-split'],
    [t('nonBillable'), agg.nonBillableDayTotals, agg.nonBillableWeekTotal, 'week-foot-split'],
  ];
  for (const [label, totals, total, cls] of footRows) {
    const footRow = document.createElement('tr');
    footRow.className = cls;
    const footLabel = document.createElement('td');
    footLabel.textContent = label;
    footRow.appendChild(footLabel);
    for (const dt of totals) {
      const td = document.createElement('td');
      td.textContent = dt > 0 ? formatHoursForDisplay(dt) : '';
      footRow.appendChild(td);
    }
    const footTotal = document.createElement('td');
    footTotal.textContent = formatHoursForDisplay(total);
    footRow.appendChild(footTotal);
    tfoot.appendChild(footRow);
  }

  renderWeekSummary(agg);
}

function renderWeekSummary(agg) {
  const share = core.billableShare(agg.billableWeekTotal, agg.weekTotal);
  const shareEl = document.getElementById('week-billable-share');
  shareEl.hidden = share === null;
  shareEl.textContent =
    share === null
      ? ''
      : t('weekShareLine', {
          billable: formatHoursForDisplay(agg.billableWeekTotal),
          nonBillable: formatHoursForDisplay(agg.nonBillableWeekTotal),
          pct: share,
        });

  const norm = state.settings.weeklyBillableNorm;
  const normEl = document.getElementById('week-norm');
  normEl.hidden = !(norm > 0);
  if (!(norm > 0)) return;
  const done = agg.billableWeekTotal;
  const left = Math.max(0, norm - done);
  document.getElementById('week-norm-line').textContent = t(left > 0.001 ? 'weekNormLine' : 'weekNormReached', {
    done: formatHoursForDisplay(done),
    norm: formatHoursForDisplay(norm),
    left: formatHoursForDisplay(left),
  });
  const progress = document.getElementById('week-norm-progress');
  progress.max = norm;
  progress.value = Math.min(done, norm);
}

function formatHoursForDisplay(h) {
  if (state.settings.hoursFormat === 'hm') return core.formatHM(h);
  return core.formatDecimalHours(h, decimalSeparator());
}

document.getElementById('week-prev-btn').addEventListener('click', () => {
  weekCursor = core.addDays(weekCursor, -7);
  renderWeek();
});
document.getElementById('week-next-btn').addEventListener('click', () => {
  weekCursor = core.addDays(weekCursor, 7);
  renderWeek();
});
document.getElementById('week-this-btn').addEventListener('click', () => {
  weekCursor = core.getWeekStart(now());
  renderWeek();
});

// ---------- Settings view ----------

function renderSettings() {
  document.getElementById('settings-round-unit').value = String(state.settings.roundUnitMinutes);
  document.getElementById('settings-round-mode').value = state.settings.roundMode;
  document.getElementById('settings-hours-format').value = state.settings.hoursFormat;
  document.getElementById('settings-delete-weeks').value = state.settings.deleteOlderThanWeeks || '';
  renderWeeklyNorm();
}

function renderWeeklyNorm() {
  const norm = state.settings.weeklyBillableNorm;
  document.getElementById('settings-weekly-norm').value = norm > 0 ? core.formatDecimalHours(norm, decimalSeparator()) : '';
}

document.getElementById('settings-round-unit').addEventListener('change', (e) => {
  state = core.updateSettings(state, { roundUnitMinutes: Number(e.target.value) });
  persist();
});
document.getElementById('settings-round-mode').addEventListener('change', (e) => {
  state = core.updateSettings(state, { roundMode: e.target.value });
  persist();
});
document.getElementById('settings-hours-format').addEventListener('change', (e) => {
  state = core.updateSettings(state, { hoursFormat: e.target.value });
  persist();
});
// Empty turns the target off; "37,5", "37.5" and "37:30" all work.
// Anything else keeps the old target.
document.getElementById('settings-weekly-norm').addEventListener('change', (e) => {
  const raw = e.target.value.trim();
  const ms = raw === '' ? null : core.parseTimeInput(raw);
  const ok = raw === '' || ms > 0;
  if (ok) {
    state = core.updateSettings(state, { weeklyBillableNorm: ms ? ms / 3600000 : null });
    persist();
  }
  document.getElementById('settings-weekly-norm-error').hidden = ok;
  renderWeeklyNorm();
});
document.getElementById('settings-delete-weeks').addEventListener('change', (e) => {
  state = core.updateSettings(state, { deleteOlderThanWeeks: Number(e.target.value) || null });
  persist();
});
document.getElementById('settings-delete-weeks-btn').addEventListener('click', () => {
  const weeks = state.settings.deleteOlderThanWeeks;
  if (!weeks || weeks < 1) return;
  showConfirm(
    t('settingsDeleteOldConfirm', { weeks }),
    () => {
      state = core.pruneOlderThan(state, weeks, now());
      persist();
      rerenderAll();
    },
    t('settingsDeleteOldApply'),
  );
});

document.getElementById('lang-toggle').addEventListener('click', () => {
  const next = state.settings.language === 'nl' ? 'en' : 'nl';
  state = core.updateSettings(state, { language: next });
  persist();
  rerenderAll();
});

// ---------- Backup ----------

document.getElementById('backup-export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `legaltimers-backup-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('backup-import-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const errorEl = document.getElementById('backup-error');
  errorEl.hidden = true;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(String(reader.result));
    } catch (err) {
      data = null;
    }
    if (!data || !validateBackupShape(data)) {
      errorEl.textContent = t('backupImportInvalid');
      errorEl.hidden = false;
      e.target.value = '';
      return;
    }
    showConfirm(
      t('backupImportConfirm'),
      () => {
        state = withLanguage(normalizeState(data));
        persist();
        rerenderAll();
      },
      t('backupImport'),
    );
    e.target.value = '';
  };
  reader.readAsText(file);
});

// ---------- first-use notice ----------

const NOTICE_KEY = 'legaltimers:notice-dismissed';

function maybeShowFirstUseNotice() {
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(NOTICE_KEY) === '1';
  } catch (e) {
    dismissed = false;
  }
  if (!dismissed) {
    document.getElementById('first-use-notice').hidden = false;
    document.body.classList.add('has-notice');
  }
}

document.getElementById('first-use-dismiss').addEventListener('click', () => {
  document.getElementById('first-use-notice').hidden = true;
  document.body.classList.remove('has-notice');
  try {
    window.localStorage.setItem(NOTICE_KEY, '1');
  } catch (e) {
    // ignore
  }
});

// ---------- boot ----------

rerenderAll();
maybeShowFirstUseNotice();

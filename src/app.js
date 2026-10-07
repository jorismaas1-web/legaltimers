import * as core from './core.js';
import { createStorage, validateBackupShape } from './storage.js';
import { detectLanguage, translate } from './i18n.js';

const store = createStorage(window.localStorage);
let state = store.load();
if (!state.settings.language) {
  state = core.updateSettings(state, { language: detectLanguage(navigator.language) });
}

let focusNewDossierFor = null;
let weekCursor = core.getWeekStart(Date.now());
const cardEls = new Map();

function t(key) {
  return translate(state.settings.language, key);
}

function persist() {
  store.save(state);
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
  setActiveTab(btn.dataset.tab);
});

// ---------- confirm dialog ----------

function showConfirm(message, onConfirm) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-message').textContent = message;
  dialog.hidden = false;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
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
  const activityInput = node.querySelector('.card-activity');
  const timeInput = node.querySelector('.card-time');
  const startPauseBtn = node.querySelector('.card-startpause');
  const readyBtn = node.querySelector('.card-ready');
  const deleteBtn = node.querySelector('.card-delete');

  dossierInput.placeholder = t('dossierPlaceholder');
  activityInput.placeholder = t('activityPlaceholder');
  dossierInput.value = clock.dossier;
  activityInput.value = clock.activity;

  dossierInput.addEventListener('change', () => {
    state = core.updateClock(state, clock.id, { dossier: dossierInput.value });
    state = core.recordDossierUsed(state, dossierInput.value);
    persist();
    renderDossierHistory();
  });
  activityInput.addEventListener('change', () => {
    state = core.updateClock(state, clock.id, { activity: activityInput.value });
    persist();
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

  cardEls.set(clock.id, { node, dossierInput, activityInput, timeInput, startPauseBtn, readyBtn });
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
    if (document.activeElement !== entry.dossierInput) entry.dossierInput.value = clock.dossier;
    if (document.activeElement !== entry.activityInput) entry.activityInput.value = clock.activity;
    entry.node.classList.toggle('is-running', !!(state.running && state.running.clockId === clock.id));
    entry.startPauseBtn.textContent = state.running && state.running.clockId === clock.id ? t('pause') : t('start');
    entry.readyBtn.textContent = t('ready');
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

  updateLongRunBanner();
  tick();
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
  const res = core.addClock(state, { dossier: '', activity: state.settings.defaultActivity }, now());
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
  const current = core.formatHMS(now() - state.running.startedAt);
  const answer = window.prompt(`${t('longRunCorrect')} (h:mm:ss)`, current);
  if (answer === null) return;
  const parsed = core.parseTimeInput(answer);
  if (parsed === null) return;
  const correctedEnd = state.running.startedAt + parsed;
  state = core.pauseRunning(state, correctedEnd);
  persist();
  renderCards();
});

// ---------- tick (live display) ----------

function tick() {
  const day = today();
  const n = now();

  for (const clock of core.activeClocks(state)) {
    const entry = cardEls.get(clock.id);
    if (!entry) continue;
    if (document.activeElement !== entry.timeInput) {
      entry.timeInput.value = core.formatHMS(core.elapsedForDay(state, clock.id, day, n));
    }
  }

  const totalMs = core.totalForDayAllClocks(state, day, n);
  document.getElementById('header-today-total').textContent = core.formatHMS(totalMs);

  if (state.running) {
    const clock = state.clocks.find((c) => c.id === state.running.clockId);
    const elapsedToday = core.elapsedForDay(state, state.running.clockId, day, n);
    const label = core.formatHM(elapsedToday / 3600000);
    document.title = `▶ ${label} · ${clock ? clock.dossier || clock.activity || '' : ''}`.trim();
  } else {
    document.title = t('appTitle');
  }

  updateLongRunBanner();
}

setInterval(tick, 1000);

// ---------- keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(document.activeElement)) return;
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

function renderDay() {
  const day = today();
  const n = now();
  const rows = core.getDaySummaryRows(state, day, n);
  const tbody = document.getElementById('day-table-body');
  tbody.innerHTML = '';

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.classList.toggle('row-overgenomen', row.overgenomen);

    const roundedHours = core.roundHoursMs(row.elapsedMs, state.settings.roundUnitMinutes, state.settings.roundMode);
    const hoursDisplay = state.settings.hoursFormat === 'hm' ? core.formatHM(roundedHours) : core.formatDecimalHours(roundedHours);
    const dossierNumber = core.extractDossierNumber(row.dossier);

    const tdDossier = document.createElement('td');
    tdDossier.append(row.dossier, copyButton(dossierNumber, t('copyDossier')));

    const tdActivity = document.createElement('td');
    tdActivity.textContent = row.activity;

    const tdExact = document.createElement('td');
    tdExact.textContent = core.formatHMS(row.elapsedMs);

    const tdHours = document.createElement('td');
    tdHours.append(hoursDisplay, copyButton(hoursDisplay, t('copyHours')));

    const tdDescription = document.createElement('td');
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = row.description;
    descInput.addEventListener('click', (e) => e.stopPropagation());
    descInput.addEventListener('change', () => {
      state = core.setDescription(state, row.clockId, day, descInput.value);
      persist();
    });
    tdDescription.append(descInput, copyButton(() => descInput.value, t('copyDescription')));

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

    tr.append(tdDossier, tdActivity, tdExact, tdHours, tdDescription, tdOvergenomen);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('input, button, a')) return;
      state = core.setOvergenomen(state, row.clockId, day, !row.overgenomen);
      persist();
      renderDay();
    });

    tbody.appendChild(tr);
  }
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
    copyToClipboard(value);
  });
  return btn;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

document.getElementById('copy-day-table-btn').addEventListener('click', () => {
  const day = today();
  const n = now();
  const rows = core.getDaySummaryRows(state, day, n).map((row) => {
    const roundedHours = core.roundHoursMs(row.elapsedMs, state.settings.roundUnitMinutes, state.settings.roundMode);
    const hoursDisplay = state.settings.hoursFormat === 'hm' ? core.formatHM(roundedHours) : core.formatDecimalHours(roundedHours);
    return { date: day, dossier: row.dossier, activity: row.activity, hours: hoursDisplay, description: row.description };
  });
  copyToClipboard(core.buildDayTSV(rows));
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
    th.textContent = labels[i];
    if (core.weekHasUnprocessed(state, day, n)) th.classList.add('week-day-dot');
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
    for (const h of row.hours) {
      const td = document.createElement('td');
      td.textContent = h > 0 ? formatHoursForDisplay(h) : '';
      tr.appendChild(td);
    }
    const tdTotal = document.createElement('td');
    tdTotal.textContent = formatHoursForDisplay(row.total);
    tr.appendChild(tdTotal);
    tbody.appendChild(tr);
  }

  const tfoot = document.getElementById('week-table-foot');
  tfoot.innerHTML = '';
  const footRow = document.createElement('tr');
  const footLabel = document.createElement('td');
  footLabel.textContent = t('weekTotalRow');
  footRow.appendChild(footLabel);
  for (const dt of agg.dayTotals) {
    const td = document.createElement('td');
    td.textContent = dt > 0 ? formatHoursForDisplay(dt) : '';
    footRow.appendChild(td);
  }
  const footTotal = document.createElement('td');
  footTotal.textContent = formatHoursForDisplay(agg.weekTotal);
  footRow.appendChild(footTotal);
  tfoot.appendChild(footRow);
}

function formatHoursForDisplay(h) {
  return state.settings.hoursFormat === 'hm' ? core.formatHM(h) : core.formatDecimalHours(h);
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
  document.getElementById('settings-default-activity').value = state.settings.defaultActivity || '';
  document.getElementById('settings-round-unit').value = String(state.settings.roundUnitMinutes);
  document.getElementById('settings-round-mode').value = state.settings.roundMode;
  document.getElementById('settings-hours-format').value = state.settings.hoursFormat;
  document.getElementById('settings-delete-weeks').value = state.settings.deleteOlderThanWeeks || '';
}

document.getElementById('settings-default-activity').addEventListener('change', (e) => {
  state = core.updateSettings(state, { defaultActivity: e.target.value });
  persist();
});
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
document.getElementById('settings-delete-weeks').addEventListener('change', (e) => {
  state = core.updateSettings(state, { deleteOlderThanWeeks: Number(e.target.value) || null });
  persist();
});
document.getElementById('settings-delete-weeks-btn').addEventListener('click', () => {
  const weeks = state.settings.deleteOlderThanWeeks;
  if (!weeks || weeks < 1) return;
  showConfirm(`${t('settingsDeleteOldApply')}: ${weeks}w`, () => {
    state = core.pruneOlderThan(state, weeks, now());
    persist();
    renderWeek();
  });
});

document.getElementById('lang-toggle').addEventListener('click', () => {
  const next = state.settings.language === 'nl' ? 'en' : 'nl';
  state = core.updateSettings(state, { language: next });
  persist();
  applyI18n();
  renderCards();
  renderDay();
  renderWeek();
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
    showConfirm(t('backupImportConfirm'), () => {
      state = { ...core.createInitialState(), ...data };
      persist();
      applyI18n();
      renderCards();
      renderDay();
      renderWeek();
      renderSettings();
    });
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
  if (!dismissed) document.getElementById('first-use-notice').hidden = false;
}

document.getElementById('first-use-dismiss').addEventListener('click', () => {
  document.getElementById('first-use-notice').hidden = true;
  try {
    window.localStorage.setItem(NOTICE_KEY, '1');
  } catch (e) {
    // ignore
  }
});

// ---------- boot ----------

applyI18n();
renderDossierHistory();
renderCards();
renderDay();
renderSettings();
maybeShowFirstUseNotice();

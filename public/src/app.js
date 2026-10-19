import * as core from './core.js';
import { createStorage, validateBackup, normalizeState, STORAGE_KEY, MAX_IMPORT_BYTES } from './storage.js';
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
let state = loadState();

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

// Reads the stored state. If it was unreadable the storage module has already
// copied the raw text aside; the banner offers it as a download.
function loadState() {
  const loaded = withLanguage(store.load());
  const unreadable = store.lastLoadProblem === 'unreadable';
  if (unreadable) document.getElementById('storage-unreadable').hidden = false;
  return loaded;
}

function persist(opts) {
  const result = store.trySave(state, opts);
  if (result === 'conflict') {
    // Another tab saved newer data. Writing now would delete its changes.
    state = loadState();
    rerenderAll();
    document.getElementById('sync-notice').hidden = false;
    return false;
  }
  const ok = result === 'ok';
  // Stays visible until a later save succeeds.
  document.getElementById('storage-warning').hidden = ok;
  if (ok) document.getElementById('sync-notice').hidden = true;
  return ok;
}

// Another tab with this page saved (or cleared storage, key === null): take
// over its state. Saves from a stale tab are refused in persist() anyway.
window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== STORAGE_KEY) return;
  state = loadState();
  rerenderAll();
});

function rerenderAll() {
  applyI18n();
  renderDossierHistory();
  renderCards();
  renderDayUnlessEditing();
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
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1; // roving tabindex: arrow keys move between tabs
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

// Standard tablist keys: Left/Right (wrapping), Home, End; the tab you land
// on is activated right away.
document.getElementById('tabs').addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const btns = [...document.querySelectorAll('.tab-btn')];
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  let target = null;
  if (e.key === 'ArrowRight') target = btns[(i + 1) % btns.length];
  else if (e.key === 'ArrowLeft') target = btns[(i - 1 + btns.length) % btns.length];
  else if (e.key === 'Home') target = btns[0];
  else if (e.key === 'End') target = btns[btns.length - 1];
  if (!target) return;
  e.preventDefault();
  target.focus();
  target.click();
});

// ---------- confirm dialog ----------

function showConfirm(message, onConfirm, okLabel = t('delete')) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-message').textContent = message;
  const opener = document.activeElement;
  dialog.hidden = false;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = okLabel;
  // Every confirm here deletes or replaces data, so focus starts on the safe
  // button.
  cancel.focus();
  function cleanup() {
    dialog.hidden = true;
    ok.removeEventListener('click', onOk);
    cancel.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey, true);
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  }
  function onOk() {
    cleanup();
    onConfirm();
  }
  function onCancel() {
    cleanup();
  }
  // Keep Tab inside the dialog and let Escape cancel.
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Tab') {
      const order = [cancel, ok];
      const i = order.indexOf(document.activeElement);
      e.preventDefault();
      const next = e.shiftKey ? (i <= 0 ? order.length - 1 : i - 1) : (i + 1) % order.length;
      order[i < 0 ? 0 : next].focus();
    }
  }
  ok.addEventListener('click', onOk);
  cancel.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey, true);
}

// ---------- cards (Timers view) ----------

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Descriptions are saved while typing (not only on `change`), so text typed
// without leaving the field survives a reload or crash.
const DESCRIPTION_SAVE_MS = 500;
function debouncedSave(save) {
  let timer = null;
  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        save();
      }, DESCRIPTION_SAVE_MS);
    },
    flush() {
      clearTimeout(timer);
      timer = null;
      save();
    },
  };
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
    state = core.renameClock(state, clock.id, dossierInput.value, now());
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
  const saveCardDescription = debouncedSave(() => {
    if (!state.clocks.some((c) => c.id === clock.id)) return;
    state = core.setDescription(state, clock.id, descInput.dataset.day || today(), descInput.value);
    persist();
  });
  descInput.addEventListener('input', saveCardDescription.schedule);
  descInput.addEventListener('change', saveCardDescription.flush);
  billableBtn.addEventListener('click', () => {
    state = core.setClockBillable(state, clock.id, !core.isBillable(state, clock.id, today()), now());
    persist();
    renderCards();
  });
  // Like the description: an edit begun before midnight stays on that day.
  timeInput.addEventListener('focus', () => {
    timeInput.dataset.day = today();
  });
  timeInput.addEventListener('change', () => {
    const day = timeInput.dataset.day || today();
    const ms = core.parseTimeInput(timeInput.value);
    if (ms === null) {
      timeInput.value = core.formatHMS(core.elapsedForDay(state, clock.id, day, now()));
      return;
    }
    state = core.setManualElapsed(state, clock.id, day, ms, now());
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
    const dossierName = clock.dossier.trim() || t('unnamedDossier');
    entry.dossierInput.setAttribute('aria-label', t('cardDossierLabel'));
    entry.descInput.setAttribute('aria-label', t('cardDescriptionLabel', { dossier: dossierName }));
    entry.timeInput.setAttribute('aria-label', t('cardTimeLabel', { dossier: dossierName }));
    entry.descInput.placeholder = t('descriptionPlaceholder');
    syncCardDescription(entry, clock.id, day);
    entry.node.classList.toggle('is-running', running);
    entry.node.classList.toggle('is-ready', ready);
    entry.node.classList.toggle('is-nonbillable', !billable);
    setText(entry.startPauseBtn, running ? t('pause') : t('start'));
    setText(entry.readyBtn, ready ? `${t('ready')} ✓` : t('ready'));
    const todayOnly = billable !== core.clockBillableDefault(state, clock.id, day);
    setBillableToggle(entry.billableBtn, billable, t('cardBillableTitle'), todayOnly ? ` (${t('todayOnly')})` : '');
    entry.deleteBtn.setAttribute('aria-label', t('deleteTimer'));
    entry.deleteBtn.title = t('deleteTimer');
  }

  for (const [clockId, entry] of [...cardEls.entries()]) {
    if (!seen.has(clockId)) {
      entry.node.remove();
      cardEls.delete(clockId);
    }
  }

  // One card has its own ✕, so the bulk button only shows from two cards on.
  document.getElementById('delete-all-btn').hidden = seen.size < 2;

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

// Only touch the text when it changes. A dossier `change` (fired by the
// mousedown that blurs the input) re-renders the cards; replacing a button's
// text node between mousedown and mouseup makes Safari/WebKit drop the click.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// Same cause, bigger effect: rebuilding a table on that `change` removes the
// element under the pointer, and the click (on a checkbox or copy button in
// another row) is lost in every browser. While a pointer is down, run the
// re-render only after the click has landed.
let pointerIsDown = false;
const pointerWaiters = new Set();
const POINTER_END = ['pointerup', 'pointercancel'];
function releasePointer() {
  setTimeout(() => {
    pointerIsDown = false;
    for (const w of [...pointerWaiters]) w.run();
  }, 0);
}
document.addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
// Window level too, and on blur: a press inside the page released outside the
// window sends no pointerup to the document.
for (const type of POINTER_END) {
  document.addEventListener(type, releasePointer, true);
  window.addEventListener(type, releasePointer, true);
}
window.addEventListener('blur', releasePointer);
// A deferred render runs exactly once: on release, on window blur, or after
// at most MAX_POINTER_WAIT_MS, whichever comes first.
const MAX_POINTER_WAIT_MS = 1000;
function afterPointer(fn) {
  if (!pointerIsDown) {
    fn();
    return;
  }
  const waiter = {
    run() {
      if (!pointerWaiters.delete(waiter)) return;
      clearTimeout(waiter.timer);
      fn();
    },
  };
  waiter.timer = setTimeout(() => {
    pointerIsDown = false;
    waiter.run();
  }, MAX_POINTER_WAIT_MS);
  pointerWaiters.add(waiter);
}

function setBillableToggle(btn, billable, title, suffix = '') {
  setText(btn, (billable ? t('billable') : t('nonBillable')) + suffix);
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

document.getElementById('delete-all-btn').addEventListener('click', () => {
  const count = core.activeClocks(state).length;
  showConfirm(t('confirmDeleteAllTimers', { count }), () => {
    state = core.removeAllClocks(state, now());
    persist();
    renderCards();
  });
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
  if (core.needsLongRunReview(state.running, state.longRunDecisions[key], now())) {
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
  state = { ...state, longRunDecisions: { ...state.longRunDecisions, [key]: { keptAt: now() } } };
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
  // Rendering the day view replaces its inputs, so a description still being
  // typed there is saved first (blur fires its change handler).
  if (lastTickDay !== null && lastTickDay !== day) {
    // A Week view showing the week of the day that just ended ("this week")
    // moves on to the new current week; a week the user browsed to stays.
    const [py, pm, pd] = lastTickDay.split('-').map(Number);
    if (weekCursor === core.getWeekStart(new Date(py, pm - 1, pd, 12).getTime())) weekCursor = core.getWeekStart(n);
    lastTickDay = day;
    if (document.getElementById('view-day').contains(document.activeElement)) document.activeElement.blur();
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

  // Same for the Week view: running time and totals move on without a click.
  // Skipped while a pointer is down or focus is inside it, since the rebuild
  // would swallow the click or the focus.
  const weekView = document.getElementById('view-week');
  if (
    state.running &&
    weekView.classList.contains('is-active') &&
    !pointerIsDown &&
    !weekView.contains(document.activeElement) &&
    n - lastWeekRender > 60000
  ) {
    renderWeek();
  }
}

setInterval(tick, 1000);

// ---------- keyboard shortcuts ----------

// Space keeps its normal meaning on anything interactive (a focused Start
// button must start its timer, not pause all).
const INTERACTIVE = 'button, a[href], select, summary, input, textarea, [role="button"], [role="checkbox"], [role="tab"], [role="link"], [contenteditable]';

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(document.activeElement)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.getElementById('confirm-dialog').hidden) return;
  if (!document.getElementById('view-timers').classList.contains('is-active')) return;
  if (e.key === ' ') {
    const el = document.activeElement;
    if (el && el.closest(INTERACTIVE)) return;
    e.preventDefault(); // no page scroll, also while the key repeats
  }
  if (e.repeat) return; // holding a key must not toggle again and again
  if (e.key >= '1' && e.key <= '9') {
    const idx = Number(e.key) - 1;
    const clock = core.activeClocks(state)[idx];
    if (clock) toggleStartPause(clock.id);
  } else if (e.key === ' ') {
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

// A rebuild must not steal focus: remember which control of which row has it
// (and the caret) and put it back on the new row.
function captureDayFocus() {
  const el = document.activeElement;
  const tbody = document.getElementById('day-table-body');
  if (!el || !tbody.contains(el) || !el.dataset.control) return null;
  const tr = el.closest('tr[data-clock-id]');
  if (!tr) return null;
  const isText = el.tagName === 'INPUT' && el.type === 'text';
  return {
    clockId: tr.dataset.clockId,
    control: el.dataset.control,
    start: isText ? el.selectionStart : null,
    end: isText ? el.selectionEnd : null,
  };
}

function restoreDayFocus(saved) {
  if (!saved) return;
  const tr = [...document.querySelectorAll('#day-table-body tr[data-clock-id]')].find((r) => r.dataset.clockId === saved.clockId);
  const el = tr && [...tr.querySelectorAll('[data-control]')].find((c) => c.dataset.control === saved.control);
  if (!el) return;
  el.focus();
  if (saved.start !== null) {
    try {
      el.setSelectionRange(saved.start, saved.end);
    } catch (e) {
      // not a selectable input
    }
  }
}

// A re-render caused by another tab must not destroy the input being typed
// in: wait until focus leaves the table, then rebuild once.
let dayRenderPending = false;
function renderDayUnlessEditing() {
  const tbody = document.getElementById('day-table-body');
  if (tbody.contains(document.activeElement)) {
    dayRenderPending = true;
    return;
  }
  renderDay();
}
document.getElementById('day-table-body').addEventListener('focusout', () => {
  if (!dayRenderPending) return;
  // Let focus settle on its next element first; stay pending if it is still
  // in the table (or the window itself lost focus).
  setTimeout(() => {
    if (!dayRenderPending || document.getElementById('day-table-body').contains(document.activeElement)) return;
    afterPointer(() => {
      if (dayRenderPending) renderDay();
    });
  }, 0);
});

function renderDay() {
  dayRenderPending = false;
  const focusBefore = captureDayFocus();
  lastDayRender = now();
  updateManualDayLabel();
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
    tr.dataset.clockId = row.clockId;
    const rowName = row.dossier.trim() || t('unnamedDossier');
    tr.classList.toggle('row-overgenomen', row.overgenomen);
    tr.classList.toggle('row-nonbillable', !row.billable);

    // Read from state, not from `row`: after a time edit the table re-renders
    // only once the click has landed, so a Copy click in this row must not
    // see the old value. (The shown hours are not updated mid-click either:
    // a wider number would shift the copy button out from under the pointer.)
    const currentHours = () => {
      const current = core.getDaySummaryRows(state, day, now()).find((r) => r.clockId === row.clockId);
      const ms = current ? current.elapsedMs : 0;
      return formatHoursForDisplay(core.roundHoursMs(ms, state.settings.roundUnitMinutes, state.settings.roundMode));
    };
    const hoursText = currentHours();
    const dossierNumber = core.extractDossierNumber(row.dossier);
    // Ticking Entered records the amount that is on screen now.
    const currentMinutes = () => {
      const current = core.getDaySummaryRows(state, day, now()).find((r) => r.clockId === row.clockId);
      return current ? current.roundedMinutes : row.roundedMinutes;
    };

    const tdDossier = document.createElement('td');
    tdDossier.append(row.dossier, copyButton(dossierNumber, t('copyDossier'), rowName, 'copy-dossier'));
    if (row.ready) {
      const badge = document.createElement('span');
      badge.className = 'ready-badge';
      badge.textContent = t('ready');
      tdDossier.append(badge);
    }

    // Editable: corrects the time for this day (0 removes the row).
    const tdExact = document.createElement('td');
    const exactInput = document.createElement('input');
    exactInput.type = 'text';
    exactInput.className = 'day-exact';
    exactInput.value = core.formatHMS(row.elapsedMs);
    exactInput.title = t('exactTimeTitle');
    exactInput.dataset.control = 'exact';
    exactInput.setAttribute('aria-label', t('rowExactLabel', { dossier: rowName }));
    exactInput.autocomplete = 'off';
    exactInput.addEventListener('click', (e) => e.stopPropagation());
    exactInput.addEventListener('change', () => {
      const ms = core.parseTimeInput(exactInput.value);
      if (ms === null) {
        exactInput.value = core.formatHMS(row.elapsedMs);
        return;
      }
      state = core.setManualElapsed(state, row.clockId, day, ms, now());
      persist();
      // The extra tick lets focus land on the control the user moved to (Tab
      // or click) before the rows are rebuilt around it.
      afterPointer(() =>
        setTimeout(() => {
          renderDay();
          tick();
        }, 0),
      );
    });
    tdExact.appendChild(exactInput);

    const tdHours = document.createElement('td');
    tdHours.append(hoursText, copyButton(currentHours, t('copyHours'), rowName, 'copy-hours'));

    const tdDescription = document.createElement('td');
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = row.description;
    descInput.autocomplete = 'off';
    descInput.dataset.control = 'description';
    descInput.setAttribute('aria-label', t('rowDescriptionLabel', { dossier: rowName }));
    const descList = document.createElement('datalist');
    descList.id = `day-desc-suggestions-${row.clockId}`;
    descInput.setAttribute('list', descList.id);
    descInput.addEventListener('focus', () => fillSuggestions(descList, row.dossier));
    descInput.addEventListener('click', (e) => e.stopPropagation());
    const saveDescription = debouncedSave(() => {
      state = core.setDescription(state, row.clockId, day, descInput.value);
      persist();
    });
    descInput.addEventListener('input', saveDescription.schedule);
    descInput.addEventListener('change', saveDescription.flush);
    tdDescription.append(descInput, descList, copyButton(() => descInput.value, t('copyDescription'), rowName, 'copy-description'));

    const tdBillable = document.createElement('td');
    const billableBtn = document.createElement('button');
    billableBtn.type = 'button';
    billableBtn.className = 'billable-toggle';
    billableBtn.dataset.control = 'billable';
    setBillableToggle(billableBtn, row.billable, t('dayBillableTitle'));
    billableBtn.setAttribute('aria-label', t('rowBillableLabel', { dossier: rowName }));
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
    checkbox.dataset.control = 'overgenomen';
    checkbox.setAttribute('aria-label', t('rowOvergenomenLabel', { dossier: rowName }));
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      state = core.setOvergenomen(state, row.clockId, day, checkbox.checked, currentMinutes());
      persist();
      renderDay();
    });
    tdOvergenomen.appendChild(checkbox);
    if (row.enteredMinutes !== undefined) {
      const hint = document.createElement('span');
      hint.className = 'entered-before';
      hint.textContent = t('enteredBefore', { hours: formatHoursForDisplay(row.enteredMinutes / 60) });
      tdOvergenomen.appendChild(hint);
    }

    const tdDelete = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'row-delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title = t('deleteDayTime');
    deleteBtn.dataset.control = 'delete';
    deleteBtn.setAttribute('aria-label', `${t('deleteDayTime')}: ${rowName}`);
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirm(t('confirmDeleteDayTime', { dossier: row.dossier || '-', day: formatDayLabel(day) }), () => {
        state = core.deleteDayTime(state, row.clockId, day, now());
        persist();
        renderDay();
        renderCards();
      });
    });
    tdDelete.appendChild(deleteBtn);

    tr.append(tdDossier, tdExact, tdHours, tdDescription, tdBillable, tdOvergenomen, tdDelete);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('input, button, a')) return;
      state = core.setOvergenomen(state, row.clockId, day, !row.overgenomen, currentMinutes());
      persist();
      renderDay();
    });

    tbody.appendChild(tr);
  }

  renderDayFoot(rows);
  restoreDayFocus(focusBefore);
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
  detail.colSpan = 4;
  detail.textContent = t(share === null ? 'daySplitLine' : 'daySplitLineShare', {
    billable: formatHoursForDisplay(split.billable),
    nonBillable: formatHoursForDisplay(split.nonBillable),
    pct: share,
  });
  tr.append(label, exact, hours, detail);
  tfoot.appendChild(tr);
}

function copyButton(valueOrFn, label, rowName, control) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cell-copy-btn';
  btn.textContent = '⎘';
  btn.title = label;
  btn.dataset.control = control;
  btn.setAttribute('aria-label', `${label}: ${rowName}`);
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

// ---------- manual entries (Day view) ----------

const manualForm = document.getElementById('manual-entry-form');
const manualDossier = document.getElementById('manual-dossier');
const manualTime = document.getElementById('manual-time');
const manualDescription = document.getElementById('manual-description');
const manualBillable = document.getElementById('manual-billable');
const manualError = document.getElementById('manual-entry-error');

function showManualError(key) {
  manualError.textContent = key ? t(key) : '';
  manualError.hidden = !key;
}

// The day an entry goes to is fixed when the form opens, so a form opened
// before midnight still adds to that day.
let manualDay = null;

function updateManualDayLabel() {
  document.getElementById('manual-entry-day').textContent = manualDay ? t('forDay', { day: formatDayLabel(manualDay) }) : '';
}

function closeManualForm() {
  manualDay = null;
  updateManualDayLabel();
  manualForm.reset();
  showManualError(null);
  manualForm.hidden = true;
}

document.getElementById('manual-entry-open').addEventListener('click', () => {
  if (!manualForm.hidden) {
    closeManualForm();
    return;
  }
  manualForm.hidden = false;
  manualDay = shownDay();
  updateManualDayLabel();
  manualTime.placeholder = t('manualTimePlaceholder');
  manualBillable.checked = true;
  manualDossier.focus();
});
document.getElementById('manual-entry-cancel').addEventListener('click', closeManualForm);

// The billable box starts at what the dossier's timer has on that day.
manualDossier.addEventListener('change', () => {
  manualBillable.checked = core.billableForDossier(state, manualDossier.value, manualDay || shownDay());
});
manualDescription.addEventListener('focus', () => {
  fillSuggestions(document.getElementById('manual-description-suggestions'), manualDossier.value);
});

manualForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!manualDossier.value.trim()) {
    showManualError('manualErrorDossier');
    manualDossier.focus();
    return;
  }
  const ms = core.parseTimeInput(manualTime.value);
  if (!(ms > 0)) {
    showManualError('manualErrorTime');
    manualTime.focus();
    return;
  }
  const res = core.addManualEntry(
    state,
    { dossier: manualDossier.value, day: manualDay || shownDay(), ms, description: manualDescription.value, billable: manualBillable.checked },
    now(),
  );
  state = res.state;
  persist();
  closeManualForm();
  renderDossierHistory();
  renderDay();
  renderCards();
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

let lastWeekRender = 0;

function renderWeek() {
  const n = now();
  lastWeekRender = n;
  const agg = core.aggregateWeek(state, weekCursor, n, {
    roundUnitMinutes: state.settings.roundUnitMinutes,
    roundMode: state.settings.roundMode,
    hoursFormat: state.settings.hoursFormat,
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
  const ms = raw === '' ? null : core.parseTimeInput(raw, 168);
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

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('backup-export-btn').addEventListener('click', () => {
  downloadText(`legaltimers-backup-${today()}.json`, JSON.stringify(state, null, 2));
});

document.getElementById('unreadable-download-btn').addEventListener('click', () => {
  downloadText(`legaltimers-unreadable-${today()}.json`, store.quarantinedRaw || '');
  document.getElementById('storage-unreadable').hidden = true;
});

// Runs the render-critical core functions on a candidate state, so a backup
// that passes the shape checks but would still crash the UI is refused
// before it replaces anything.
function dryRunRender(candidate) {
  const n = now();
  core.getDaySummaryRows(candidate, core.dayKey(n), n);
  core.aggregateWeek(candidate, core.getWeekStart(n), n, candidate.settings);
  core.descriptionSuggestions(candidate, candidate.clocks.length ? candidate.clocks[0].dossier : '');
}

function showImportError(errorEl, reason) {
  errorEl.textContent = reason ? `${t('backupImportInvalid')} (${reason})` : t('backupImportInvalid');
  errorEl.hidden = false;
}

document.getElementById('backup-import-input').addEventListener('change', (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const errorEl = document.getElementById('backup-error');
  errorEl.hidden = true;
  if (file.size > MAX_IMPORT_BYTES) {
    errorEl.textContent = t('backupImportTooBig');
    errorEl.hidden = false;
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    input.value = '';
    let data = null;
    try {
      data = JSON.parse(String(reader.result));
    } catch (err) {
      showImportError(errorEl, 'JSON');
      return;
    }
    const check = validateBackup(data);
    if (!check.ok) {
      showImportError(errorEl, check.reason);
      return;
    }
    let candidate;
    try {
      candidate = withLanguage(normalizeState(data));
      dryRunRender(candidate);
    } catch (err) {
      showImportError(errorEl, 'render');
      return;
    }
    showConfirm(
      t('backupImportConfirm'),
      () => {
        state = candidate;
        // A deliberate overwrite: wins over whatever another tab saved.
        persist({ force: true });
        rerenderAll();
      },
      t('backupImport'),
    );
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

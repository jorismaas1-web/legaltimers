import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { start } from './server.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ENGINES = { chromium, firefox, webkit };
const wanted = (process.env.BROWSERS || 'chromium,firefox,webkit').split(',').map((s) => s.trim()).filter(Boolean);

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, prefix + name + '/'));
    else if (name !== '_headers') out.push(prefix + name);
  }
  return out;
}
// Known static files of the site, plus the root document itself.
const ALLOWED_PATHS = new Set(['/', ...listFiles(PUBLIC).map((f) => '/' + f)]);

const CLIPBOARD_STUB = () => {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (s) => { window.__copied.push(String(s)); return Promise.resolve(); } },
  });
};

for (const name of wanted) {
  describe(`e2e [${name}]`, () => {
    let srv;
    let browser;
    before(async () => {
      srv = await start(0);
      browser = await ENGINES[name].launch();
    });
    after(async () => {
      await browser?.close();
      await srv?.close();
    });

    // Fresh context and page per test, with network, console and error capture.
    async function open() {
      const context = await browser.newContext({ acceptDownloads: true, locale: 'nl-NL' });
      await context.addInitScript(CLIPBOARD_STUB);
      const page = await context.newPage();
      const log = { requests: [], problems: [] };
      page.on('request', (r) => log.requests.push({ method: r.method(), url: r.url() }));
      page.on('pageerror', (e) => log.problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        const text = m.text();
        if (/content security policy|refused to|violat/i.test(text)) log.problems.push(`console: ${text}`);
      });
      srv.requests.length = 0;
      await page.goto(srv.base + '/');
      await page.waitForSelector('#new-timer-btn');
      return { context, page, log };
    }

    function assertClean(log) {
      assert.deepEqual(log.problems, []);
      for (const r of log.requests) {
        const u = new URL(r.url);
        // blob: and data: stay inside the page and never reach a network.
        if (u.protocol === 'blob:' || u.protocol === 'data:') continue;
        assert.equal(r.method, 'GET', `non-GET request: ${r.method} ${r.url}`);
        assert.equal(u.origin, srv.base, `off-origin request: ${r.url}`);
        assert.equal(u.search, '', `query string in request: ${r.url}`);
        assert.equal(u.hash, '', `hash in request: ${r.url}`);
        assert.ok(ALLOWED_PATHS.has(u.pathname), `request for unknown file: ${r.url}`);
      }
      // The same check from the server's side.
      for (const r of srv.requests) {
        const u = new URL(r.url, srv.base);
        assert.equal(r.method, 'GET', `server saw ${r.method} ${r.url}`);
        assert.equal(u.search, '', `server saw query string: ${r.url}`);
        assert.ok(ALLOWED_PATHS.has(u.pathname), `server saw unknown path: ${r.url}`);
      }
    }

    async function addTimer(page, dossier, time) {
      const before = await page.locator('.card').count();
      await page.click('#new-timer-btn');
      await page.waitForFunction((n) => document.querySelectorAll('.card').length === n + 1, before);
      const card = page.locator('.card').nth(before);
      if (dossier) await card.locator('.card-dossier').fill(dossier);
      if (time) {
        await card.locator('.card-time').fill(time);
        await card.locator('.card-time').press('Tab');
      }
      return card;
    }

    async function dayWithRows(page, n) {
      await addTimer(page, 'Alpha 1', '1:00');
      if (n > 1) await addTimer(page, 'Beta 2', '0:30');
      await page.click('[data-tab="day"]');
      await page.waitForFunction((k) => document.querySelectorAll('#day-table-body tr').length >= k, n);
    }

    test('realistic session makes no request beyond the site static files', async () => {
      const { context, page, log } = await open();
      const c1 = await addTimer(page, 'Dossier A', '1:00');
      const c2 = await addTimer(page, 'Dossier B', '0:45');
      const c3 = await addTimer(page, 'Dossier C');
      await c1.locator('.card-description').fill('Bellen met client');
      await c1.locator('.card-description').press('Tab');
      await c1.locator('.card-startpause').click();
      await c2.locator('.card-startpause').click();
      await page.waitForTimeout(1200);
      await c3.locator('.card-startpause').click();
      await page.click('#pause-all-btn');

      await page.click('[data-tab="day"]');
      await page.waitForSelector('#day-table-body tr');
      const exact = page.locator('#day-table-body .day-exact').first();
      await exact.fill('1:30');
      await exact.press('Tab');
      await page.locator('#day-table-body .cell-copy-btn').first().click();
      await page.locator('#day-table-body input[type="checkbox"]').first().click();
      await page.click('#copy-day-table-btn');
      await page.click('#manual-entry-open');
      await page.fill('#manual-dossier', 'Handmatig 9');
      await page.fill('#manual-time', '0:20');
      await page.fill('#manual-description', 'Nabellen');
      await page.click('#manual-entry-form button[type="submit"]');
      await page.waitForFunction(() => document.getElementById('day-table-body').textContent.includes('Handmatig 9'));

      await page.click('[data-tab="week"]');
      await page.waitForSelector('#week-table-body tr');
      await page.click('[data-tab="settings"]');
      await page.selectOption('#settings-round-unit', '15');
      await page.selectOption('#settings-round-mode', 'nearest');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#backup-export-btn'),
      ]);
      assert.match(download.suggestedFilename(), /^legaltimers-backup-.*\.json$/);
      await page.click('#lang-toggle');

      assertClean(log);
      assert.ok(log.requests.length >= 4, 'page should have loaded its own files');
      await context.close();
    });

    test('CSP is enforced: fetch, WebSocket, off-origin image and inline script are blocked', async () => {
      const { context, page } = await open();
      srv.requests.length = 0;
      const result = await page.evaluate(async () => {
        const violations = [];
        document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
        const out = {};
        try { await fetch('/x'); out.fetch = 'allowed'; } catch { out.fetch = 'blocked'; }
        out.ws = await new Promise((resolve) => {
          try {
            const ws = new WebSocket('ws://127.0.0.1:1/x');
            ws.onopen = () => resolve('allowed');
            ws.onerror = () => resolve('blocked');
            setTimeout(() => resolve('timeout'), 3000);
          } catch { resolve('blocked'); }
        });
        out.img = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve('allowed');
          img.onerror = () => resolve('blocked');
          img.src = 'http://127.0.0.1:1/leak.gif?d=1';
          setTimeout(() => resolve('timeout'), 3000);
        });
        window.__inlineRan = false;
        const s = document.createElement('script');
        s.textContent = 'window.__inlineRan = true';
        document.head.appendChild(s);
        await new Promise((r) => setTimeout(r, 200));
        out.inline = window.__inlineRan ? 'allowed' : 'blocked';
        out.violations = violations;
        return out;
      });
      assert.equal(result.fetch, 'blocked');
      assert.equal(result.ws, 'blocked');
      assert.equal(result.img, 'blocked');
      assert.equal(result.inline, 'blocked');
      const has = (d) => result.violations.some((v) => v.startsWith(d));
      assert.ok(has('connect-src'), `violations: ${result.violations}`);
      assert.ok(has('script-src'), `violations: ${result.violations}`);
      assert.ok(has('img-src'), `violations: ${result.violations}`);
      // None of the attempts reached the server.
      assert.deepEqual(srv.requests, []);
      await context.close();
    });

    test('regression: typing a dossier then clicking Start right away starts the timer', async () => {
      const { context, page } = await open();
      await page.click('#new-timer-btn');
      const card = page.locator('.card').first();
      await card.locator('.card-dossier').click();
      await page.keyboard.type('Zaak 123');
      await card.locator('.card-startpause').click();
      await page.waitForTimeout(1500);
      const first = await card.locator('.card-time').inputValue();
      await page.waitForTimeout(1500);
      const second = await card.locator('.card-time').inputValue();
      assert.notEqual(second, first, 'time display should keep advancing');
      assert.notEqual(second, '0:00:00');
      assert.equal(await card.locator('.card-dossier').inputValue(), 'Zaak 123');
      await context.close();
    });

    test('regression: Day view, editing exact time then clicking another row Entered checkbox checks it', async () => {
      const { context, page } = await open();
      await dayWithRows(page, 2);
      const rows = page.locator('#day-table-body tr');
      const box = rows.nth(1).locator('input[type="checkbox"]');
      assert.equal(await box.isChecked(), false);
      await rows.nth(0).locator('.day-exact').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('2:00');
      await box.click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#day-table-body tr').nth(1).locator('input[type="checkbox"]').isChecked(), true);
      assert.match(await page.locator('#day-table-body .day-exact').first().inputValue(), /2:00/);
      await context.close();
    });

    test('regression: editing exact time then clicking Copy hours copies the new rounded value', async () => {
      const { context, page } = await open();
      await dayWithRows(page, 1);
      const row = page.locator('#day-table-body tr').first();
      await row.locator('.day-exact').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('2:00');
      const copyBtns = row.locator('.cell-copy-btn');
      assert.ok((await copyBtns.count()) >= 2);
      // The rounded-hours cell is the second copy button of the row.
      await copyBtns.nth(1).click();
      await page.waitForFunction(() => window.__copied.length > 0);
      const copied = await page.evaluate(() => window.__copied);
      assert.match(copied[copied.length - 1], /^2([.,]0+)?$|^2:00$/, `copied ${JSON.stringify(copied)}`);
      await context.close();
    });

    test('persistence: values survive reload and the first-use notice can be dismissed', async () => {
      const { context, page } = await open();
      assert.equal(await page.locator('#first-use-notice').isVisible(), true);
      await page.click('#first-use-dismiss');
      assert.equal(await page.locator('#first-use-notice').isVisible(), false);
      const card = await addTimer(page, 'Blijvend 7', '1:00');
      await card.locator('.card-description').fill('Omschrijving X');
      await card.locator('.card-description').press('Tab');
      await page.reload();
      await page.waitForSelector('.card');
      assert.equal(await page.locator('#first-use-notice').isVisible(), false);
      assert.equal(await page.locator('.card-dossier').first().inputValue(), 'Blijvend 7');
      assert.equal(await page.locator('.card-description').first().inputValue(), 'Omschrijving X');
      assert.match(await page.locator('.card-time').first().inputValue(), /1:00/);
      await context.close();
    });
  });
}

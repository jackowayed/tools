import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startBackend } from './fixture.js';

let mf, server, browser, origin;
const errors = [];
before(async () => {
  ({ mf } = await startBackend());
  server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await mf.dispatchFetch(origin + req.url, { method: req.method,
          headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } else {
        const name = req.url.slice(1);
        if (!['baby-weight.html', 'sync-client.js', 'sync-protocol.js'].includes(name)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(await readFile(new URL('../' + name, import.meta.url)));
      }
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mf?.dispose();
});
async function open(context) {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/baby-weight.html');
  await page.waitForFunction(() => !document.querySelector('#addReading').disabled);
  return page;
}
async function add(page, kg) {
  await page.locator('#unitKg').click();
  await page.locator('#kg').waitFor({ state: 'visible' });
  await page.locator('#kg').fill(String(kg));
  await page.locator('#addReading').click();
  await page.waitForFunction(() => document.querySelector('#kg').value === '');
}
async function rows(page, count) {
  await page.waitForFunction(n => document.querySelectorAll('#table tbody tr').length === n, count);
}
async function synced(page) {
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'Up to date');
}
async function savedBirth(page) {
  return page.evaluate(async () => {
    const { LocalLog, visibleState } = await import('/sync-client.js');
    const log = await LocalLog.open({ broadcast: false });
    try { return visibleState(await log.read()).settings.birth; }
    finally { log.close(); }
  });
}

test('Chromium: incomplete birth dates survive refreshes without clearing the saved date', async () => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await open(context);
  const birth = page.locator('#birthDate');
  await birth.fill('2025-01-02');
  await page.locator('#sexGirl').click();
  await page.waitForFunction(() => document.querySelector('#settingsSummary').textContent.includes('Jan 2, 2025'));
  assert.equal(await savedBirth(page), '2025-01-02');

  // Delete just the month segment: value is empty, but day/year remain.
  await birth.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  assert.equal(await birth.inputValue(), '');
  assert.equal(await birth.evaluate(el => el.validity.badInput), true);
  await page.locator('#sexBoy').click();
  await page.waitForFunction(() => document.querySelector('#sexBoy').classList.contains('active'));
  assert.equal(await birth.evaluate(el => el.validity.badInput), true);
  assert.equal(await savedBirth(page), '2025-01-02');

  // Completing the missing month preserves the other segments and saves.
  await birth.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('03');
  await page.locator('#sexGirl').focus();
  await page.waitForFunction(() => document.querySelector('#settingsSummary').textContent.includes('Mar 2, 2025'));
  assert.equal(await birth.inputValue(), '2025-03-02');
  assert.equal(await savedBirth(page), '2025-03-02');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#birthDate').disabled);
  await page.locator('#babySettings summary').click();
  assert.equal(await birth.inputValue(), '2025-03-02');

  // Intentionally clearing the whole input must still persist.
  await birth.fill('');
  await page.locator('#sexGirl').focus();
  await page.waitForFunction(() => document.querySelector('#settingsSummary').textContent.startsWith('Set birth date'));
  assert.equal(await savedBirth(page), '');
  await context.close();
});

test('Chromium: storage refreshes and failed saves preserve the birth date draft', async () => {
  const context = await browser.newContext();
  const page = await open(context), tab = await open(context);
  const birth = page.locator('#birthDate');
  await birth.focus();
  await birth.evaluate(el => { el.value = '2025-04-03'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await tab.locator('#sexGirl').click();
  await page.waitForFunction(() => document.querySelector('#sexGirl').classList.contains('active'));
  assert.equal(await birth.inputValue(), '2025-04-03');
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await birth.dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#err').textContent.includes('Not saved'));
  await page.locator('#sexGirl').focus();
  assert.equal(await birth.inputValue(), '2025-04-03');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  await birth.dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#settingsSummary').textContent.includes('Apr 3, 2025'));
  assert.equal(await savedBirth(page), '2025-04-03');
  await context.close();
});

test('Chromium: collapsed sync settings and compact table follow the entry unit', async () => {
  const context = await browser.newContext();
  const page = await open(context);
  assert.equal(await page.locator('#babySettings summary').textContent(), 'Age & Sync Settings');
  await page.locator('#babySettings summary').click();
  assert.equal(await page.locator('#syncKey').isVisible(), false);
  await page.locator('#babySettings summary').click();
  assert.equal(await page.locator('#syncKey').isVisible(), true);
  assert.deepEqual(await page.locator('.input-pills .pill-state').allInnerTexts(), ['Naked', 'Before feed']);
  await page.locator('#clothingStateLabel').click();
  assert.equal(await page.locator('#clothedToggle').isChecked(), true);
  assert.equal(await page.locator('#clothingStateLabel').innerText(), 'Clothed');
  await page.locator('#clothedToggle').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#clothingStateLabel').innerText(), 'Naked');
  await page.locator('#feedToggle').click();
  assert.equal(await page.locator('#feedStateLabel').innerText(), 'After feed');
  await page.locator('#feedStateLabel').click();
  assert.equal(await page.locator('#feedStateLabel').innerText(), 'Before feed');
  await add(page, 3);
  await page.locator('#feedToggle').check();
  await add(page, 3.1);
  assert.equal(await page.locator('#feedStateLabel').innerText(), 'Before feed');
  await rows(page, 2);
  assert.deepEqual(await page.locator('#table th').allTextContents(), ['Date', 'Weight', 'Age', 'Percentile', 'Clothed', 'Change fromprevious matching', 'Time', 'Before/After', '']);
  assert.deepEqual(await page.locator('#table .cell-value').allTextContents(), ['3.1 kg', '3 kg']);
  assert.deepEqual(await page.locator('#table tbody td:nth-child(6)').allTextContents(), ['+100 g', '—']);
  assert.equal(await page.locator('#table tbody .del').count(), 2);
  assert.equal(await page.locator('#table .alt').count(), 0);
  await page.locator('#unitLb').click();
  await page.waitForFunction(() => document.querySelector('#table .cell-value').textContent.includes('lb'));
  assert.deepEqual(await page.locator('#table .cell-value').allTextContents(), ['6 lb 13.3 oz', '6 lb 9.8 oz']);
  assert.deepEqual(await page.locator('#table tbody td:nth-child(6)').allTextContents(), ['+3.5 oz', '—']);
  await context.close();
});

test('Chromium: feed label follows clicks and keyboard when the app module cannot load', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/sync-client.js', route => route.abort());
  await page.goto(origin + '/baby-weight.html');
  const toggle = page.locator('#feedToggle');
  const label = page.locator('#feedStateLabel');
  await toggle.click();
  assert.equal(await label.innerText(), 'After feed');
  await label.click();
  assert.equal(await label.innerText(), 'Before feed');
  await toggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await label.innerText(), 'After feed');
  await context.close();
});

test('Chromium: migration, multi-tab adds, two-device sync, offline deletion, reload, save failure', async () => {
  const first = await browser.newContext(), second = await browser.newContext();
  await first.addInitScript(() => {
    localStorage.setItem('babyWeightSettings', JSON.stringify({ birth: '2023-01-01', sex: 'female', unit: 'lb' }));
    localStorage.setItem('babyWeightLog', JSON.stringify([{ type: 'weight', id: 'legacy-entry', ts: 1700000000000, kg: 3, afterFeed: false }]));
  });
  const a = await open(first), tab = await open(first), b = await open(second);
  await rows(a, 1); await rows(tab, 1);
  assert.equal(await a.locator('#babySettings').evaluate(el => el.open), false);
  assert.equal(await b.locator('#babySettings').evaluate(el => el.open), true);
  await a.locator('#babySettings summary').click();
  await Promise.all([add(a, 3.1), add(tab, 3.2)]);
  await rows(a, 3); await rows(tab, 3);
  await a.locator('#syncCreate').click(); await synced(a);
  const credential = await a.locator('#syncKey').inputValue(); assert.match(credential, /^bw1\./);
  await b.locator('#syncKey').fill(credential); await b.locator('#syncConnect').click(); await synced(b); await rows(b, 3);
  await first.setOffline(true);
  await add(tab, 3.3); await rows(a, 4);
  a.once('dialog', dialog => dialog.accept());
  await a.locator('#table .del[data-id="legacy-entry"]').click(); await rows(a, 3); await rows(tab, 3);
  await first.setOffline(false);
  await a.reload(); await a.waitForFunction(() => !document.querySelector('#addReading').disabled); await synced(a);
  await a.locator('#babySettings summary').click();
  await b.locator('#syncRetry').click(); await synced(b); await rows(b, 3);
  await b.waitForFunction(() => !document.querySelector('#table .del[data-id="legacy-entry"]'));
  await rows(b, 3);
  await a.locator('#syncDisconnect').click();
  await a.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith('Disconnected'));
  await add(a, 3.4); await rows(a, 4);
  await a.reload(); await a.waitForFunction(() => !document.querySelector('#addReading').disabled);
  await a.locator('#babySettings summary').click();
  assert.match(await a.locator('#syncStatus').textContent(), /Disconnected.*1 changes/);
  await a.locator('#syncConnect').click(); await synced(a);
  await b.locator('#syncRetry').click(); await synced(b); await rows(b, 4);
  // A quota failure must preserve the input and must not create a visible row.
  await a.evaluate(() => { window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Storage full', 'QuotaExceededError'); }; });
  await a.locator('#kg').fill('3.5'); await a.locator('#addReading').click();
  await a.waitForFunction(() => document.querySelector('#err').textContent.includes('Not saved'));
  assert.equal(await a.locator('#kg').inputValue(), '3.5'); await rows(a, 4);
  await a.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  const status = await b.evaluate(async () => {
    const response = await fetch('/api/sync/append', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${document.querySelector('#syncKey').value}` },
      body: JSON.stringify({ v: 1, ops: ['__proto__', 'constructor'].map(entryId => ({
        v: 1, opId: crypto.randomUUID(), type: 'add-entry', entryId, timestamp: 1600000000000, kg: 3, afterFeed: true,
      })) }),
    });
    return response.status;
  });
  assert.equal(status, 200);
  await b.locator('#syncRetry').click(); await rows(b, 6);
  assert.deepEqual(errors, []);
  await first.close(); await second.close();
});


test('Chromium: past entries can be corrected, cancelled, reloaded and synced', async () => {
  const first = await browser.newContext({ locale: 'en-GB', timezoneId: 'UTC' });
  const second = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const a = await open(first), b = await open(second);
  await a.locator('#unitKg').click();
  await a.locator('#kg').fill('3.123456');
  await a.locator('#useCustomTime').check();
  await a.locator('#datetime').fill('2026-10-01T13:05');
  await a.locator('#addReading').click();
  await rows(a, 1);
  assert.equal(await a.locator('#table thead th:nth-child(7)').textContent(), 'Time');
  assert.equal(await a.locator('#table .cell-time').textContent(), '1:05 PM');
  assert.equal(await a.locator('#feedStateLabel').innerText(), 'Before feed');
  assert.ok(await a.evaluate(() => !!(document.querySelector('.feed').compareDocumentPosition(document.querySelector('#babySettings')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  const beforeColor = await a.locator('#table .cell-value').evaluate(el => getComputedStyle(el).backgroundColor);
  await a.locator('#syncCreate').click(); await synced(a);
  await b.locator('#syncKey').fill(await a.locator('#syncKey').inputValue());
  await b.locator('#syncConnect').click(); await synced(b); await rows(b, 1);
  await first.setOffline(true);
  await a.locator('#table .edit').click();
  await a.locator('#feedToggle').check();
  await a.locator('#clothedToggle').check();
  assert.equal(await a.locator('#clothingStateLabel').innerText(), 'Clothed');
  assert.equal(await a.locator('#feedStateLabel').innerText(), 'After feed');
  await a.locator('#addReading').click();
  await a.waitForFunction(() => document.querySelector('#cancelEdit').hidden);
  await rows(a, 1);
  assert.equal(await a.locator('#table .cell-feed').textContent(), 'After');
  assert.notEqual(await a.locator('#table .cell-value').evaluate(el => getComputedStyle(el).backgroundColor), beforeColor);
  await first.setOffline(false);
  await a.reload(); await rows(a, 1);
  assert.equal(await a.locator('#table .cell-feed').textContent(), 'After');
  await a.locator('#tabList').click();
  await a.locator('#feed .edit').click();
  await a.locator('#kg').fill('4');
  await a.locator('#cancelEdit').click();
  await a.locator('#feed .edit').click();
  assert.equal(await a.locator('#kg').inputValue(), '3.123456');
  assert.equal(await a.locator('#clothedToggle').isChecked(), true);
  assert.equal(await a.locator('#datetime').inputValue(), '2026-10-01T13:05');
  await a.locator('#kg').fill('3.2');
  await a.locator('#datetime').fill('2026-10-02T00:05');
  await a.locator('#addReading').click();
  await a.waitForFunction(() => document.querySelector('#cancelEdit').hidden);
  await first.setOffline(false);
  await a.locator('#syncRetry').click();
  await a.waitForFunction(async () => {
    const { LocalLog } = await import('/sync-client.js');
    const log = await LocalLog.open({ broadcast: false });
    try { return (await log.read()).pending.length === 0; } finally { log.close(); }
  });
  await synced(a);
  await b.locator('#syncRetry').click(); await synced(b); await rows(b, 1);
  await b.waitForFunction(() => document.querySelector('#table .cell-value').textContent === '7 lb 0.9 oz');
  assert.equal(await b.locator('#table .cell-value').textContent(), '7 lb 0.9 oz');
  assert.equal(await b.locator('#table .cell-feed').textContent(), 'After');
  assert.equal(await b.locator('#table .cell-time').textContent(), '12:05 AM');
  await first.close(); await second.close();
});


test('Chromium: row changes compare consecutive weigh-ins regardless of feed status', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('babyWeightSettings', JSON.stringify({ unit: 'kg' }));
    localStorage.setItem('babyWeightLog', JSON.stringify([
      { id: 'oldest', type: 'weight', ts: 1700000000000, kg: 3, afterFeed: true },
      { id: 'middle', type: 'weight', ts: 1700100000000, kg: 3.1, afterFeed: false },
      { id: 'newer', type: 'weight', ts: 1700200000000, kg: 3.05, afterFeed: false },
      { id: 'latest', type: 'weight', ts: 1700300000000, kg: 3.05, afterFeed: true },
    ]));
  });
  const page = await open(context);
  await rows(page, 4);
  assert.deepEqual(await page.locator('.cell-change').allTextContents(), ['0 g', '−50 g', '+100 g', '—']);
  assert.deepEqual(await page.locator('.cell-feed').allTextContents(), ['After', 'Before', 'Before', 'After']);
  assert.equal(await page.locator('#table tbody tr:first-child td:last-child button:first-child').getAttribute('aria-label'), 'Delete weigh-in');
  // Removing the previous weigh-in recalculates the change against the new adjacent row.
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#table .del[data-id="middle"]').click(); await rows(page, 3);
  assert.deepEqual(await page.locator('.cell-change').allTextContents(), ['0 g', '+50 g', '—']);
  await context.close();
});

test('Chromium: clothed percentile deducts 5 oz; changes skip other clothing statuses', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const allowance = 5 / 16 * 0.45359237;
    localStorage.setItem('babyWeightSettings', JSON.stringify({ birth: '2023-11-01', sex: 'female', unit: 'kg' }));
    localStorage.setItem('babyWeightLog', JSON.stringify([
      { id: 'n1', type: 'weight', ts: 1700000000000, kg: 3, afterFeed: false },
      { id: 'c1', type: 'weight', ts: 1700000600000, kg: 3 + allowance, afterFeed: false, clothed: true },
      { id: 'n2', type: 'weight', ts: 1700001200000, kg: 3.1, afterFeed: true },
      { id: 'c2', type: 'weight', ts: 1700001200000, kg: 3.1 + allowance, afterFeed: true, clothed: true },
    ]));
  });
  const page = await open(context);
  await rows(page, 4);
  const row = id => page.locator(`#table tr:has(.edit[data-id="${id}"])`);
  assert.equal(await row('n2').locator('.cell-pct').textContent(), await row('c2').locator('.cell-pct').textContent());
  assert.equal(await row('n2').locator('.cell-pct em').count(), 0);
  assert.equal(await row('c2').locator('.cell-pct em').evaluate(el => getComputedStyle(el).fontStyle), 'italic');
  assert.match(await row('c2').locator('.cell-pct').getAttribute('title'), /5 oz/);
  assert.deepEqual(await page.locator('.cell-change').allTextContents(), ['+100 g', '+100 g', '—', '—']);
  await page.locator('#tabList').click();
  assert.deepEqual(await page.locator('.ate-line').allTextContents(), [
    '🍼 Ate ~+100 g (3.5 oz) · 20 min after before-feed weigh-in',
    '🍼 Ate ~+100 g (3.5 oz) · 10 min after before-feed weigh-in',
  ]);
  assert.equal(await page.locator('#feed .pill.pct em').count(), 2);
  await page.locator('#clothedToggle').check();
  assert.equal(await page.locator('#clothingStateLabel').innerText(), 'Clothed');
  await add(page, 3.5); await rows(page, 5);
  assert.equal(await page.locator('#clothedToggle').isChecked(), false);
  await page.reload(); await rows(page, 5);
  assert.equal(await page.locator('#table .cell-clothed').first().textContent(), '👕');
  // Deleting the previous clothed reading removes only its matching change.
  page.once('dialog', dialog => dialog.accept());
  await row('c1').locator('.del').click(); await rows(page, 4);
  assert.equal(await row('c2').locator('.cell-change').textContent(), '—');
  assert.equal(await row('n2').locator('.cell-change').textContent(), '+100 g');
  await context.close();
});


test('Chromium: clothing column follows percentile and survives reload', async () => {
  const context = await browser.newContext();
  try {
    const page = await open(context);
    await page.locator('#clothedToggle').check();
    await add(page, 3.5);
    await rows(page, 1);
    assert.deepEqual(await page.locator('#table th').allTextContents(), ['Date', 'Weight', 'Age', 'Percentile', 'Clothed', 'Change fromprevious matching', 'Time', 'Before/After', '']);
    assert.equal(await page.locator('.cell-clothed').textContent(), '👕');
    assert.equal(await page.locator('#clothedToggle').isChecked(), false);
    await add(page, 3.6);
    await rows(page, 2);
    assert.deepEqual(await page.locator('.cell-clothed').allTextContents(), ['✖️', '👕']);
    await page.reload();
    await rows(page, 2);
    assert.deepEqual(await page.locator('.cell-clothed').allTextContents(), ['✖️', '👕']);
  } finally { await context.close(); }
});

test('Chromium: reset requires typed confirmation, clears other tabs and can recover server data', async () => {
  const context = await browser.newContext();
  try {
    const a = await open(context);
    await a.locator('#birthDate').fill('2025-01-02');
    await a.locator('#sexGirl').click();
    await add(a, 3.5);
    await a.locator('#syncCreate').click(); await synced(a);
    const credential = await a.locator('#syncKey').inputValue();
    const tab = await open(context);
    await a.evaluate(() => {
      localStorage.setItem('babyWeightLog', '[{"id":"legacy","ts":1700000000000,"kg":4}]');
      localStorage.setItem('babyWeightSettings', '{"sex":"male"}');
      localStorage.setItem('babyWeightLog.rejected', '[{}]');
      localStorage.setItem('other-tool', 'keep');
    });
    await a.locator('#resetClient').click();
    assert.match(await a.locator('#resetKeyReminder').innerText(), /Save your sync key/);
    assert.equal(await a.locator('#resetConfirm').isDisabled(), true);
    await a.locator('#resetConfirmation').fill('wrong');
    assert.equal(await a.locator('#resetConfirm').isDisabled(), true);
    await a.locator('#resetCancel').click();
    await rows(a, 1);
    await a.locator('#resetClient').click();
    await a.locator('#resetConfirmation').fill('DeLeTe');
    await a.locator('#resetConfirm').click();
    for (const p of [a, tab]) {
      await p.waitForFunction(() => !document.querySelector('#resetClient').disabled && document.querySelector('#birthDate').value === '' && document.querySelector('#syncKey').value === '');
      assert.equal(await p.locator('#table tbody tr').count(), 0);
      assert.equal(await p.locator('#sexGirl').evaluate(el => el.classList.contains('active')), false);
      assert.equal(await p.locator('#unitLb').evaluate(el => el.classList.contains('active')), true);
    }
    assert.deepEqual(await a.evaluate(() => [localStorage.getItem('babyWeightLog'), localStorage.getItem('babyWeightSettings'), localStorage.getItem('babyWeightLog.rejected'), localStorage.getItem('other-tool')]), [null, null, null, 'keep']);
    await a.reload();
    await a.waitForFunction(() => !document.querySelector('#resetClient').disabled);
    assert.equal(await a.locator('#table tbody tr').count(), 0);
    await a.locator('#syncKey').fill(credential);
    await a.locator('#syncConnect').click(); await synced(a); await rows(a, 1);
    assert.equal(await a.locator('#birthDate').inputValue(), '2025-01-02');
    assert.equal(await a.locator('#sexGirl').evaluate(el => el.classList.contains('active')), true);
  } finally { await context.close(); }
});

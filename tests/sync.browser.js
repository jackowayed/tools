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

test('Chromium: collapsed sync settings and compact table follow the entry unit', async () => {
  const context = await browser.newContext();
  const page = await open(context);
  assert.equal(await page.locator('#babySettings summary').textContent(), 'Age & Sync Settings');
  await page.locator('#babySettings summary').click();
  assert.equal(await page.locator('#syncKey').isVisible(), false);
  await page.locator('#babySettings summary').click();
  assert.equal(await page.locator('#syncKey').isVisible(), true);
  await page.locator('#feedToggle').click();
  assert.equal(await page.locator('#feedStateLabel').innerText(), '🍼 After feed');
  await page.locator('#feedStateLabel').click();
  assert.equal(await page.locator('#feedStateLabel').innerText(), '🪶 Before feed');
  await add(page, 3);
  await page.locator('#feedToggle').check();
  await add(page, 3.1);
  assert.equal(await page.locator('#feedStateLabel').innerText(), '🪶 Before feed');
  await rows(page, 2);
  assert.deepEqual(await page.locator('#table th').allTextContents(), ['Date', 'Weight', 'Age', '%ile', 'Feed', '']);
  assert.deepEqual(await page.locator('#table .cell-value').allTextContents(), ['3.1 kg', '3 kg']);
  assert.deepEqual(await page.locator('#table tbody td:nth-last-child(2)').allTextContents(), ['+100 g', 'Before']);
  assert.equal(await page.locator('#table tbody td:last-child .del').count(), 2);
  assert.equal(await page.locator('#table .alt').count(), 0);
  await page.locator('#unitLb').click();
  await page.waitForFunction(() => document.querySelector('#table .cell-value').textContent.includes('lb'));
  assert.deepEqual(await page.locator('#table .cell-value').allTextContents(), ['6 lb 13.3 oz', '6 lb 9.8 oz']);
  assert.deepEqual(await page.locator('#table tbody td:nth-last-child(2)').allTextContents(), ['+3.5 oz', 'Before']);
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
  assert.equal(await label.innerText(), '🍼 After feed');
  await label.click();
  assert.equal(await label.innerText(), '🪶 Before feed');
  await toggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await label.innerText(), '🍼 After feed');
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

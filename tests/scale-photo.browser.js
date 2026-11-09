import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { scaleFixture } from './scale-photo-fixture.js';

test('mobile photo fills draft only, preserves failed reads, and saves through the existing form', async () => {
  const server = createServer(async (req, res) => {
    const name = req.url.slice(1);
    if (!['baby-weight.html','scale-photo.js','sync-client.js','sync-protocol.js','sync-passphrase.js','weight-graphs.js','html-utils.js'].includes(name)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(new URL('../' + name, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/baby-weight.html`);
    await page.waitForFunction(() => !document.getElementById('addReading').disabled);
    const fixture = scaleFixture();
    const png = await page.evaluate(({ width, height, data }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
      return canvas.toDataURL().split(',')[1];
    }, { ...fixture, data: Array.from(fixture.data) });
    const file = { name: 'scale.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
    await page.setInputFiles('#scaleFile', file);
    await page.waitForFunction(() => document.getElementById('scalePhotoStatus').textContent.startsWith('Detected'));
    assert.equal(await page.inputValue('#lb'), '12');
    assert.equal(await page.inputValue('#oz'), '6.2');
    assert.equal(await page.locator('.edit').count(), 0);
    assert.equal(await page.locator('#scalePhotoPreview').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.fill('#oz', '6.3');
    await page.setInputFiles('#scaleFile', { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
    await page.waitForFunction(() => document.getElementById('scalePhotoStatus').textContent.includes('could not be opened'));
    assert.equal(await page.inputValue('#oz'), '6.3');
    await page.click('#addReading');
    await page.waitForFunction(() => document.getElementById('lb').value === '');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('addReading').disabled);
    assert.ok(await page.locator('.edit').count() > 0);
    await page.click('#unitKg');
    await page.waitForFunction(() => !document.getElementById('kgWrap').hidden);
    await page.setInputFiles('#scaleFile', file);
    await page.waitForFunction(() => document.getElementById('scalePhotoStatus').textContent.startsWith('Detected'));
    assert.ok(Math.abs(Number(await page.inputValue('#kg')) - (12 + 6.2 / 16) * .45359237) < 1e-8);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});

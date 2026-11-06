import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generatePassphrase } from '../sync-passphrase.js';
import { parseKey } from '../breastfeeding-protocol.js';
import { parseKey as parseWeightKey } from '../sync-protocol.js';
import { startBackend } from './fixture.js';

test('four independent unbiased word selections use the complete EFF list', async () => {
  const source = await readFile(new URL('../sync-passphrase.js', import.meta.url), 'utf8');
  const words = source.match(/const words = `([^`]+)`/)[1].split(/\s+/);
  assert.equal(words.length, 7776);
  assert.equal(new Set(words).size, 7776);
  const limit = Math.floor(2 ** 32 / 7776) * 7776;
  const samples = [2 ** 32 - 1, limit, 0, 7775, 7776, limit - 1];
  const phrase = generatePassphrase(buffer => { buffer[0] = samples.shift(); });
  assert.equal(phrase, [words[0], words[7775], words[0], words[7775]].join(' '));
  assert.equal(samples.length, 0, 'out-of-range samples are rejected');
  for (let i = 0; i < words.length; i += 4) {
    const phrase = words.slice(i, i + 4).join(' ');
    assert.equal(parseKey(phrase).key, phrase);
  }
});

test('normalizes case and whitespace, preserves legacy credentials and rejects malformed input', () => {
  assert.equal(parseKey('  Acorn\t BASKET\n coral   drift ').key, 'acorn basket coral drift');
  const key = `nf1.${crypto.randomUUID()}.${'a'.repeat(64)}`;
  assert.equal(parseKey(` ${key} `).key, key);
  for (const invalid of [null, 123, '', 'one two three', 'one two three four five', 'one two three 123', 'one two three <script>', 'a'.repeat(257)]) assert.throws(() => parseKey(invalid));
});

test('real server authenticates phrases, stores only hashes, and supports legacy nursing and weight clients', async () => {
  const { mf, db } = await startBackend();
  try {
    const api = (route, action, body = {}, key) => mf.dispatchFetch(`http://localhost/api/${route}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': crypto.randomUUID(), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ v: 2, ...body }),
    });
    const created = await api('nursing-sync', 'create', { credentialFormat: 'passphrase' });
    assert.equal(created.status, 201);
    const { key, datasetId } = await created.json();
    assert.equal(key.split(' ').length, 4);
    const stored = await db.prepare('SELECT * FROM datasets WHERE id = ?').bind(datasetId).first();
    assert.ok(!JSON.stringify(stored).includes(key));
    assert.equal(stored.credential_hash.length, 64);
    assert.equal((await api('nursing-sync', 'pull', { afterSeq: 0 }, key.toUpperCase().replaceAll(' ', '   '))).status, 200);
    assert.equal((await api('nursing-sync', 'pull', { afterSeq: 0 }, 'incorrect words cannot authenticate')).status, 401);
    assert.equal((await api('sync', 'pull', { afterSeq: 0 }, key)).status, 401);
    const weight = await api('sync', 'create', { credentialFormat: 'passphrase' });
    assert.equal(weight.status, 201);
    const weightAuth = await weight.json();
    assert.equal(parseWeightKey(weightAuth.key).format, 'passphrase');
    assert.equal(parseWeightKey('  ACORN  basket coral drift ').key, 'acorn basket coral drift');
    assert.equal((await api('sync', 'pull', { afterSeq: 0 }, weightAuth.key.toUpperCase())).status, 200);
    assert.equal((await api('nursing-sync', 'pull', { afterSeq: 0 }, weightAuth.key)).status, 401);
    const weightStored = await db.prepare('SELECT * FROM datasets WHERE id = ?').bind(weightAuth.datasetId).first();
    assert.ok(!JSON.stringify(weightStored).includes(weightAuth.key));
    assert.notEqual(weightAuth.datasetId, datasetId);
    for (const [route, prefix] of [['nursing-sync', 'nf1.'], ['sync', 'bw1.']]) {
      const legacy = await (await api(route, 'create')).json();
      assert.ok(legacy.key.startsWith(prefix));
      assert.equal((await api(route, 'pull', { afterSeq: 0 }, legacy.key)).status, 200);
    }
  } finally { await mf.dispose(); }
});

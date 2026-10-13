import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBackend } from './fixture.js';
import 'fake-indexeddb/auto';
import { LocalLog, SyncEngine, visibleState } from '../sync-client.js';
import { newOperation, canonicalOperation } from '../sync-protocol.js';

let mf, db;
const logs = [];
const add = (entryId = crypto.randomUUID(), kg = 3.5) => newOperation('add-entry', { entryId, timestamp: 1700000000000, kg, afterFeed: false });
const key = () => `bw1.${crypto.randomUUID()}.${'a'.repeat(64)}`;
const page = (records, afterSeq = 0, hasMore = false) => ({ v: 1, records, cursor: records.at(-1)?.seq ?? afterSeq, hasMore });
async function log(name = crypto.randomUUID(), legacy = {}) {
  const result = await LocalLog.open({ name, legacy, broadcast: false }); logs.push(result); return result;
}
async function api(action, body, credential, ip = crypto.randomUUID()) {
  return mf.dispatchFetch(`http://localhost/api/sync/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip,
      ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify({ v: 1, ...body }),
  });
}
async function create() { const response = await api('create', {}); assert.equal(response.status, 201); return (await response.json()).key; }
function fetcher(url, options) {
  return mf.dispatchFetch(`http://localhost${url}`, { ...options, headers: { ...options.headers, 'CF-Connecting-IP': crypto.randomUUID() } });
}
before(async () => { ({ mf, db } = await startBackend()); });

after(async () => { for (const item of logs) item.close(); await mf?.dispose(); });

test('D1: concurrent appenders, response loss retry, authentication, and conflicts', async () => {
  const credential = await create();
  const first = add(), second = add();
  const responses = await Promise.all([api('append', { ops: [first] }, credential), api('append', { ops: [second] }, credential)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const assigned = await Promise.all(responses.map(r => r.json()));
  assert.notEqual(assigned[0].assigned[0].seq, assigned[1].assigned[0].seq);
  const retry = await (await api('append', { ops: [first] }, credential)).json();
  assert.deepEqual(retry.assigned, assigned[0].assigned);
  assert.equal((await api('append', { ops: [add()] }, credential.slice(0, -1) + (credential.endsWith('a') ? 'b' : 'a'))).status, 401);
  assert.equal((await api('append', { ops: [{ ...first, kg: 4 }] }, credential)).status, 409);
  const newEntry = add();
  assert.equal((await api('append', { ops: [newEntry, add(first.entryId, 4)] }, credential)).status, 409);
  const pulled = await (await api('pull', { afterSeq: 0 }, credential)).json();
  assert.equal(pulled.records.length, 2, 'conflicting batch rolled back its earlier valid insert');
});

test('D1: paginated cursors preserve concurrent appends and tolerate global gaps', async () => {
  const credential = await create(), other = await create();
  for (let batch = 0; batch < 3; batch++) assert.equal((await api('append', { ops: Array.from({ length: 50 }, () => add()) }, credential)).status, 200);
  await api('append', { ops: [add()] }, other);
  const first = await (await api('pull', { afterSeq: 0 }, credential)).json();
  assert.equal(first.records.length, 100); assert.equal(first.hasMore, true);
  const final = add(); await api('append', { ops: [final] }, credential);
  const second = await (await api('pull', { afterSeq: first.cursor }, credential)).json();
  assert.equal(second.records.length, 51); assert.equal(second.hasMore, false);
  assert.equal(second.records.at(-1).op.opId, final.opId);
  assert.equal(new Set([...first.records, ...second.records].map(r => r.seq)).size, 151);
});

test('D1: duplicate entry import is accepted, changed entry is rejected, and quota permits retries', async () => {
  const credential = await create(); const original = add();
  await api('append', { ops: [original, { ...original, opId: crypto.randomUUID() }] }, credential);
  assert.equal((await api('append', { ops: [add(original.entryId, 4)] }, credential)).status, 409);
  await db.prepare('UPDATE datasets SET operation_count = 10000 WHERE id = ?').bind(credential.split('.')[1]).run();
  assert.equal((await api('append', { ops: [original] }, credential)).status, 200);
  assert.equal((await api('append', { ops: [add()] }, credential)).status, 413);
});

test('API: malformed records, protocol, origins, and throttling', async () => {
  const credential = await create();
  assert.equal((await api('append', { ops: [{ ...add(), kg: -1 }] }, credential)).status, 400);
  assert.equal((await api('append', { ops: [{ ...add(), entryId: '\" onclick=alert(1)' }] }, credential)).status, 400);
  assert.equal((await api('pull', { v: 2, afterSeq: 0 }, credential)).status, 400);
  assert.equal((await mf.dispatchFetch('http://localhost/api/sync/create', { method: 'POST', headers: { origin: 'https://elsewhere.example' } })).status, 403);
  const ip = crypto.randomUUID();
  for (let i = 0; i < 5; i++) assert.equal((await api('create', {}, null, ip)).status, 201);
  assert.equal((await api('create', {}, null, ip)).status, 429);
});

test('IndexedDB: simultaneous tabs and reload preserve mutations and migrate only once', async () => {
  const name = crypto.randomUUID();
  const a = await log(name, { entries: [{ type: 'weight', id: 'legacy123', ts: 1700000000000, kg: 3, afterFeed: false }] });
  const b = await log(name, { entries: [{ id: 'ignored', ts: 1700000000000, kg: 4 }] });
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).mutate('add-entry', { entryId: `entry${i}`, timestamp: 1700000000000, kg: 3, afterFeed: false })));
  const reopened = await log(name);
  const state = await reopened.read(); assert.equal(state.entries.length, 21); assert.equal(state.pending.length, 21);
  assert.ok(state.entries.some(e => e.id === 'legacy123')); assert.ok(!state.entries.some(e => e.id === 'ignored'));
});

test('IndexedDB: transaction abort saves neither visible mutation nor outbox', async () => {
  const local = await log();
  await assert.rejects(local.change(state => { state.entries.push({ id: 'failed' }); state.pending.push(add()); throw new Error('simulated storage failure'); }));
  assert.equal((await local.read()).entries.length, 0); assert.equal((await local.read()).pending.length, 0);
});

test('IndexedDB: tombstone before add, atomic cursor, overlapping pages, invalid page rollback', async () => {
  const local = await log(), credential = key(); await local.link(credential);
  const entry = add(); const deletion = newOperation('delete-entry', { entryId: entry.entryId });
  await local.applyPage(credential, 0, page([{ seq: 10, op: deletion }]));
  await local.applyPage(credential, 10, page([{ seq: 20, op: entry }]));
  await local.applyPage(credential, 0, page([{ seq: 10, op: deletion }]));
  assert.equal((await local.read()).sync.cursor, 20);
  assert.equal(visibleState(await local.read()).entries.length, 0);
  const good = add();
  await assert.rejects(local.applyPage(credential, 20, page([{ seq: 30, op: good }, { seq: 31, op: { ...entry, opId: crypto.randomUUID(), kg: 4 } }])));
  assert.equal((await local.read()).sync.cursor, 20); assert.equal((await local.read()).entries.length, 1);
});

test('IndexedDB: acknowledgement preserves new work and does not jump the pull cursor', async () => {
  const local = await log(), credential = key(); await local.link(credential);
  await local.mutate('set-setting', { field: 'birth', value: '2025-01-01' });
  const sent = (await local.read()).pending;
  await local.mutate('set-setting', { field: 'birth', value: '2025-02-01' });
  await local.acknowledge(credential, sent, { v: 1, assigned: [{ opId: sent[0].opId, seq: 100 }] });
  let state = await local.read(); assert.equal(state.pending.length, 1); assert.equal(state.sync.cursor, 0);
  assert.equal(visibleState(state).settings.birth, '2025-02-01');
  await local.applyPage(credential, 0, page([{ seq: 99, op: newOperation('set-setting', { field: 'birth', value: '2024-01-01' }) }]));
  state = await local.read(); assert.equal(state.settings.birth, '2025-01-01');
});

test('IndexedDB: joining adopts remote settings; disconnect and reload retain offline deletions', async () => {
  const name = crypto.randomUUID(); const local = await log(name, { settings: { birth: '2025-01-01', sex: 'male', unit: 'kg' } });
  const credential = key(); await local.link(credential);
  assert.equal((await local.read()).pending.length, 0); assert.equal(visibleState(await local.read()).settings.unit, 'kg');
  await local.disconnect(); await local.mutate('delete-entry', { entryId: 'offline-deletion' });
  const reload = await log(name); await reload.link(credential);
  assert.equal((await reload.read()).pending[0].type, 'delete-entry');
  await assert.rejects(reload.link(key()));
});

test('end to end: two devices converge, a lost response retries, settings merge per field', async () => {
  const a = await log(), b = await log();
  const engineA = new SyncEngine(a, { fetcher });
  const credential = await engineA.create();
  const engineB = new SyncEngine(b, { fetcher }); await engineB.connect(credential);
  const entryA = add(), entryB = add();
  await Promise.all([a.mutate(entryA.type, entryA), b.mutate(entryB.type, entryB)]);
  await a.mutate('set-setting', { field: 'birth', value: '2025-02-01' });
  await b.mutate('set-setting', { field: 'sex', value: 'female' });
  let lost = false;
  engineA.fetcher = async (url, options) => {
    const response = await fetcher(url, options);
    if (url.endsWith('/append') && !lost) { lost = true; throw new Error('response lost'); }
    return response;
  };
  await Promise.all([engineA.cycle().catch(() => {}), engineB.cycle()]);
  assert.ok((await a.read()).pending.length > 0);
  await engineA.cycle(); await engineB.cycle(); await engineA.cycle();
  let av = visibleState(await a.read()), bv = visibleState(await b.read());
  assert.equal(av.entries.length, 2); assert.equal(bv.entries.length, 2);
  assert.deepEqual(av.settings, bv.settings); assert.equal(av.settings.sex, 'female'); assert.equal(av.settings.birth, '2025-02-01');
  await a.disconnect(); await a.mutate('delete-entry', { entryId: entryB.entryId });
  await a.link(credential); await engineA.cycle(); await engineB.cycle();
  av = visibleState(await a.read()); bv = visibleState(await b.read());
  assert.equal(av.entries.length, 1); assert.deepEqual(av.entries, bv.entries);
  assert.equal(av.pending.length, 0); assert.equal(bv.pending.length, 0);
});

test('wire format rejects malformed settings and normalizes property order', () => {
  assert.throws(() => canonicalOperation({ v: 1, opId: 'id', type: 'set-setting', field: 'birth', value: '2025-02-30' }));
  assert.throws(() => canonicalOperation({ ...add(), timestamp: NaN }));
  const op = add(); assert.equal(JSON.stringify(canonicalOperation({ kg: op.kg, ...op })), JSON.stringify(op));
});

test('connect keeps settings edited while authentication is in flight', async () => {
  const local = await log(undefined, { settings: { sex: 'male' } });
  const credential = key();
  const engine = new SyncEngine(local, { fetcher: async () => {
    await local.mutate('set-setting', { field: 'sex', value: 'female' });
    return new Response(JSON.stringify(page([])), { status: 200 });
  } });
  await engine.connect(credential);
  assert.equal(visibleState(await local.read()).settings.sex, 'female');
  assert.equal((await local.read()).pending.length, 1);
});

test('concurrent first connections cannot mix datasets, and failed auth leaves local settings intact', async () => {
  const name = crypto.randomUUID(); const a = await log(name, { settings: { sex: 'male' } }), b = await log(name);
  const failed = new SyncEngine(a, { fetcher: async () => new Response(JSON.stringify({ error: 'Invalid sync key.' }), { status: 401 }) });
  await assert.rejects(failed.connect(key()));
  assert.equal((await a.read()).sync, null); assert.equal(visibleState(await a.read()).settings.sex, 'male');
  const results = await Promise.allSettled([a.link(key()), b.link(key())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await a.read()).sync.key, (await b.read()).sync.key);
});

test('same-field settings converge to server order and duplicate sync loops are harmless', async () => {
  const credential = await create(), name = crypto.randomUUID();
  const a = await log(name), tab = await log(name), b = await log();
  await a.link(credential); await b.link(credential);
  const engineA = new SyncEngine(a, { fetcher }), engineTab = new SyncEngine(tab, { fetcher }), engineB = new SyncEngine(b, { fetcher });
  await a.mutate('set-setting', { field: 'sex', value: 'male' });
  await Promise.all([engineA.cycle(), engineTab.cycle()]);
  await b.mutate('set-setting', { field: 'sex', value: 'female' });
  await engineB.cycle(); await engineA.cycle();
  assert.equal(visibleState(await a.read()).settings.sex, 'female');
  assert.equal(visibleState(await b.read()).settings.sex, 'female');
  const records = await (await api('pull', { afterSeq: 0 }, credential)).json();
  assert.equal(records.records.length, 2);
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBackend } from './fixture.js';
import 'fake-indexeddb/auto';
import { LocalLog, SyncEngine, visibleState } from '../sync-client.js';
import { newOperation, canonicalOperation, entryPayload } from '../sync-protocol.js';

let mf, db;
const logs = [];
const add = (entryId = crypto.randomUUID(), kg = 3.5) => newOperation('add-entry', { entryId, timestamp: 1700000000000, kg, afterFeed: false });
const fields = op => ({ entryId: op.entryId, timestamp: op.timestamp, kg: op.kg, afterFeed: op.afterFeed, ...(op.clothed === undefined ? {} : { clothed: op.clothed }) });
const key = () => `bw1.${crypto.randomUUID()}.${'a'.repeat(64)}`;
const page = (records, afterSeq = 0, hasMore = false) => ({ v: 2, records, cursor: records.at(-1)?.seq ?? afterSeq, hasMore });
async function log(name = crypto.randomUUID(), legacy = {}) {
  const result = await LocalLog.open({ name, legacy, broadcast: false }); logs.push(result); return result;
}
async function api(action, body, credential, ip = crypto.randomUUID()) {
  return mf.dispatchFetch(`http://localhost/api/sync/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip,
      ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify({ v: 2, ...body }),
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
  assert.equal((await api('pull', { v: 1, afterSeq: 0 }, credential)).status, 400);
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
  await local.acknowledge(credential, sent, { v: 2, assigned: [{ opId: sent[0].opId, seq: 100 }] });
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

test('clothing status preserves old canonical payloads and rejects non-booleans', () => {
  const old = add();
  assert.equal(JSON.stringify(canonicalOperation({ ...old, clothed: false })), JSON.stringify(old));
  assert.equal(entryPayload({ ...old, clothed: false }), entryPayload(old));
  assert.notEqual(entryPayload({ ...old, clothed: true }), entryPayload(old));
  for (const clothed of [null, 'false', 0, 1]) {
    assert.throws(() => canonicalOperation({ ...old, clothed }));
  }
});

test('clothed readings survive migration, sync, edits and reload; clothing conflicts are rejected', async () => {
  const credential = await create(), name = crypto.randomUUID();
  const a = await log(name, { entries: [
    { id: 'clothed', ts: 1700000000000, kg: 3, afterFeed: false, clothed: true },
    { id: 'naked', ts: 1700000000001, kg: 3, afterFeed: false },
  ] });
  const b = await log();
  await a.link(credential); await b.link(credential);
  const engineA = new SyncEngine(a, { fetcher }), engineB = new SyncEngine(b, { fetcher });
  await engineA.cycle(); await engineB.cycle();
  assert.deepEqual(visibleState(await a.read()).entries, visibleState(await b.read()).entries);
  assert.deepEqual(visibleState(await b.read()).entries.map(e => e.clothed), [true, false]);
  const original = (await api('pull', { afterSeq: 0 }, credential)).json();
  const op = (await original).records[0].op;
  assert.equal((await api('append', { ops: [{ ...op, opId: crypto.randomUUID(), clothed: false }] }, credential)).status, 409);
  await a.replaceEntry('clothed', { timestamp: op.timestamp, kg: op.kg, afterFeed: true, clothed: false });
  await engineA.cycle(); await engineB.cycle();
  const reopened = await log(name);
  assert.deepEqual(visibleState(await reopened.read()).entries, visibleState(await b.read()).entries);
  assert.ok(visibleState(await b.read()).entries.every(e => !e.clothed));
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


test('IndexedDB: editing atomically queues one update and preserves the entry identity', async () => {
  const a = await log();
  await a.mutate('add-entry', { entryId: 'original', timestamp: 1700000000123, kg: 3.123456, afterFeed: false });
  const fields = { timestamp: 1700000000123, kg: 3.123456, afterFeed: true };
  const before = await a.read();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  try { await assert.rejects(a.replaceEntry('original', fields), /Full/); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(await a.read(), before);
  await a.replaceEntry('original', fields);
  const state = await a.read();
  const visible = visibleState(state).entries;
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'original');
  assert.deepEqual(state.entries, before.entries, 'original add payload is immutable');
  assert.equal(visible[0].ts, fields.timestamp);
  assert.equal(visible[0].kg, fields.kg);
  assert.equal(visible[0].afterFeed, true);
  assert.deepEqual(state.pending.map(op => op.type), ['add-entry', 'update-entry']);
  await a.replaceEntry('original', { ...fields, kg: 4 });
  assert.equal(visibleState(await a.read()).entries[0].kg, 4);
  await a.mutate('delete-entry', { entryId: 'original' });
  await assert.rejects(a.replaceEntry('original', fields));
});

test('reset clears all local state, rejects stale tabs and preserves the server log', async () => {
  const name = crypto.randomUUID();
  const local = await log(name, { entries: [{ id: 'saved', ts: 1700000000000, kg: 3 }], settings: { birth: '2025-01-01', sex: 'female', unit: 'kg' } });
  const engine = new SyncEngine(local, { fetcher });
  const credential = await engine.create();
  await engine.run();
  const before = await (await api('pull', { afterSeq: 0 }, credential)).json();
  const stale = await log(name);
  await local.mutate('delete-entry', { entryId: 'saved' });
  const priorRevision = (await local.read()).revision;
  await local.reset();
  const fresh = await log(name);
  const state = await fresh.read();
  assert.ok(state.revision > priorRevision);
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.tombstones, []);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.settings, { birth: '', sex: '', unit: 'lb' });
  assert.deepEqual(state.versions, { birth: 0, sex: 0 });
  assert.equal(state.sync, null);
  await assert.rejects(stale.mutate('set-setting', { field: 'sex', value: 'male' }), /client was reset/);
  await assert.rejects(stale.link(credential), /client was reset/);
  await engine.run({ force: true });
  assert.deepEqual(await (await api('pull', { afterSeq: 0 }, credential)).json(), before);
  const newEngine = new SyncEngine(fresh, { fetcher });
  await newEngine.connect(credential);
  await newEngine.run();
  assert.equal(visibleState(await fresh.read()).entries.length, 1);
  assert.equal(visibleState(await fresh.read()).settings.sex, 'female');
});

test('protocol: historical operations retain canonical bytes while edits require v2', () => {
  const historical = [
    { v: 1, opId: 'old-add', type: 'add-entry', entryId: 'old', timestamp: 1700000000000, kg: 3, afterFeed: false },
    { v: 1, opId: 'old-delete', type: 'delete-entry', entryId: 'old' },
    { v: 1, opId: 'old-setting', type: 'set-setting', field: 'sex', value: 'female' },
  ];
  for (const op of historical) assert.equal(JSON.stringify(canonicalOperation(op)), JSON.stringify(op));
  assert.equal(add().v, 2);
  const edit = newOperation('update-entry', { entryId: 'old', timestamp: 1700000000000, kg: 4, afterFeed: true, clothed: true });
  assert.equal(edit.v, 2);
  assert.throws(() => canonicalOperation({ ...edit, v: 1 }));
  for (const kg of [undefined, NaN, -1]) assert.throws(() => canonicalOperation({ ...edit, kg }));
});

test('API: old envelopes cannot mutate datasets; historical operations upload in v2', async () => {
  const count = async () => (await db.prepare('SELECT COUNT(*) AS count FROM datasets').first()).count;
  const before = await count();
  assert.equal((await api('create', { v: 1 })).status, 400);
  assert.equal(await count(), before);
  const credential = await create(), original = { ...add(), v: 1 };
  assert.equal((await api('append', { v: 1, ops: [original] }, credential)).status, 400);
  assert.equal((await (await api('pull', { afterSeq: 0 }, credential)).json()).records.length, 0);
  assert.equal((await api('append', { ops: [original] }, credential)).status, 200);
  const pulled = await (await api('pull', { afterSeq: 0 }, credential)).json();
  assert.deepEqual(pulled.records[0].op, original);
});

test('end to end: concurrent offline edits and a lost response converge to one stable reading', async () => {
  const credential = await create(), a = await log(), b = await log();
  await a.link(credential); await b.link(credential);
  const engineA = new SyncEngine(a, { fetcher }), engineB = new SyncEngine(b, { fetcher });
  const original = add('shared-reading');
  await a.mutate(original.type, original); await engineA.cycle(); await engineB.cycle();
  await a.replaceEntry(original.entryId, { ...fields(original), kg: 4, afterFeed: true });
  await b.replaceEntry(original.entryId, { ...fields(original), kg: 5, clothed: true });
  assert.equal((await a.read()).pending.length, 1); assert.equal((await b.read()).pending.length, 1);
  let lost = false;
  engineA.fetcher = async (url, options) => {
    const response = await fetcher(url, options);
    if (url.endsWith('/append') && !lost) { lost = true; throw new Error('response lost'); }
    return response;
  };
  await assert.rejects(engineA.cycle(), /response lost/);
  await engineB.cycle(); await engineA.cycle(); await engineB.cycle();
  const av = visibleState(await a.read()), bv = visibleState(await b.read());
  assert.deepEqual(av.entries, bv.entries); assert.equal(av.entries.length, 1);
  assert.equal(av.entries[0].id, original.entryId); assert.equal(av.entries[0].kg, 5);
  assert.equal(av.entries[0].clothed, true);
  assert.equal((await a.read()).entries[0].kg, original.kg);
  const records = (await (await api('pull', { afterSeq: 0 }, credential)).json()).records;
  assert.deepEqual(records.map(r => r.op.type), ['add-entry', 'update-entry', 'update-entry']);
});

test('IndexedDB: delayed edit pages and acknowledgements preserve newer and pending edits', async () => {
  const local = await log(), credential = key(), original = add('delayed');
  await local.link(credential); await local.applyPage(credential, 0, page([{ seq: 1, op: original }]));
  const edit = kg => newOperation('update-entry', { ...fields(original), kg });
  const older = edit(4), newer = edit(5);
  await local.applyPage(credential, 1, page([{ seq: 20, op: newer }]));
  await local.applyPage(credential, 1, page([{ seq: 10, op: older }]));
  assert.equal(visibleState(await local.read()).entries[0].kg, 5);
  await local.replaceEntry(original.entryId, { ...fields(original), kg: 6 });
  const sent = (await local.read()).pending;
  await local.replaceEntry(original.entryId, { ...fields(original), kg: 7 });
  await local.acknowledge(credential, sent, { v: 2, assigned: [{ opId: sent[0].opId, seq: 15 }] });
  assert.equal(visibleState(await local.read()).entries[0].kg, 7);
  assert.equal((await local.read()).edits.find(edit => edit.op.entryId === original.entryId).seq, 20);
  assert.equal((await local.read()).pending.length, 1);
});

test('IndexedDB: delete wins over edits in either delivery order and pending overlays', async () => {
  for (const deleteFirst of [true, false]) {
    const local = await log(), credential = key(), original = add('deleted');
    await local.link(credential); await local.applyPage(credential, 0, page([{ seq: 1, op: original }]));
    await local.replaceEntry(original.entryId, { ...fields(original), kg: 6 });
    const deletion = newOperation('delete-entry', { entryId: original.entryId });
    const edit = newOperation('update-entry', { ...fields(original), kg: 7 });
    const ops = deleteFirst ? [deletion, edit] : [edit, deletion];
    await local.applyPage(credential, 1, page(ops.map((op, i) => ({ seq: i + 2, op }))));
    assert.deepEqual(visibleState(await local.read()).entries, []);
    await assert.rejects(local.replaceEntry(original.entryId, { ...fields(original), kg: 8 }));
  }
});

test('D1: an edit fits the final batch and quota slot without a half replacement', async () => {
  const credential = await create(), original = add('quota-edit');
  await api('append', { ops: [original] }, credential);
  const edit = newOperation('update-entry', { ...fields(original), kg: 4 });
  await db.prepare('UPDATE datasets SET operation_count = 9950 WHERE id = ?').bind(credential.split('.')[1]).run();
  const batch = [...Array.from({ length: 49 }, () => add()), edit];
  assert.equal((await api('append', { ops: batch }, credential)).status, 200);
  assert.equal((await api('append', { ops: [edit] }, credential)).status, 200, 'retry at quota remains idempotent');
  assert.equal((await api('append', { ops: [newOperation('update-entry', { ...fields(original), kg: 5 })] }, credential)).status, 413);
  const records = (await (await api('pull', { afterSeq: 0 }, credential)).json()).records;
  assert.equal(records.length, 51); assert.deepEqual(records.at(-1).op, edit);
});

test('IndexedDB: upgrading v1 retains pending historical operations and blocks old clients', async () => {
  const name = crypto.randomUUID(), original = { ...add('legacy-state'), v: 1 }, credential = key();
  const state = { revision: 5, entries: [{ type: 'weight', id: original.entryId, ts: original.timestamp, kg: original.kg, afterFeed: false, clothed: false }],
    tombstones: [], pending: [original], settings: { birth: '', sex: '', unit: 'kg' }, versions: { birth: 0, sex: 0 }, sync: { key: credential, cursor: 42 } };
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('state', 'readwrite');
    transaction.objectStore('state').put(state, 'current');
    transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
  });
  database.close();
  const local = await log(name), upgraded = await local.read();
  assert.deepEqual(upgraded.entries, state.entries); assert.deepEqual(upgraded.pending, [original]);
  assert.equal(upgraded.sync.cursor, 42); assert.deepEqual(upgraded.edits, []);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }), { name: 'VersionError' });
});

test('SyncEngine: persisted v1 pending operations upload inside v2 envelopes unchanged', async () => {
  const local = await log(), credential = await create(), old = { ...add('pending-v1'), v: 1 };
  await local.link(credential);
  await local.change(state => { state.pending.push(old); return state; });
  let uploaded;
  const engine = new SyncEngine(local, { fetcher: (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.v, 2);
    if (url.endsWith('/append')) uploaded = body.ops;
    return fetcher(url, options);
  } });
  await engine.cycle();
  assert.deepEqual(uploaded, [old]);
  assert.equal((await local.read()).pending.length, 0);
  assert.equal(visibleState(await local.read()).entries[0].id, old.entryId);
});

test('end to end: edit at batch and quota boundary stays whole and failed next edit stays local', async () => {
  const credential = await create(), a = await log(), b = await log();
  await a.link(credential); await b.link(credential);
  const engineA = new SyncEngine(a, { fetcher }), engineB = new SyncEngine(b, { fetcher });
  const original = add('boundary-reading');
  await a.mutate(original.type, original); await engineA.cycle(); await engineB.cycle();
  for (let i = 0; i < 49; i++) await a.mutate('set-setting', { field: 'sex', value: i % 2 ? 'male' : 'female' });
  await a.replaceEntry(original.entryId, { ...fields(original), kg: 4, clothed: true });
  assert.equal((await a.read()).pending.length, 50);
  await db.prepare('UPDATE datasets SET operation_count = 9950 WHERE id = ?').bind(credential.split('.')[1]).run();
  await engineA.cycle(); await engineB.cycle();
  const remote = visibleState(await b.read()).entries;
  assert.equal(remote.length, 1); assert.equal(remote[0].id, original.entryId);
  assert.equal(remote[0].kg, 4); assert.equal(remote[0].clothed, true);
  assert.equal((await a.read()).pending.length, 0);
  await a.replaceEntry(original.entryId, { ...fields(original), kg: 5 });
  await assert.rejects(engineA.cycle());
  await engineB.cycle();
  assert.deepEqual(visibleState(await b.read()).entries, remote);
  const local = await a.read();
  assert.equal(local.pending.length, 1); assert.equal(local.pending[0].type, 'update-entry');
  assert.equal(visibleState(local).entries.length, 1);
  assert.equal(visibleState(local).entries[0].id, original.entryId);
  assert.equal(visibleState(local).entries[0].kg, 5);
});

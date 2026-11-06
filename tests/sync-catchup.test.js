import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { LocalLog, SyncEngine, visibleState, catchUpStatus, capacityWarning } from '../sync-client.js';
import { newOperation } from '../sync-protocol.js';

const credential = `bw1.${'a'.repeat(36)}.${'b'.repeat(64)}`;
const setting = value => newOperation('set-setting', { field: 'diaperGrams', value });
async function open(t, name = crypto.randomUUID()) {
  const log = await LocalLog.open({ name, broadcast: false });
  t.after(() => log.close());
  return log;
}
function server(ops) {
  const records = ops.map((op, i) => ({ seq: (i + 1) * 2, op })); // Global sequence gaps.
  const requests = [];
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, ...body });
    const usage = () => ({ count: records.length, limit: 50000 });
    if (url.endsWith('/append')) {
      const assigned = body.ops.map(op => {
        let record = records.find(r => r.op.opId === op.opId);
        if (!record) { record = { seq: (records.at(-1)?.seq ?? 0) + 2, op }; records.push(record); }
        return { opId: op.opId, seq: record.seq };
      });
      return Response.json({ v: 2, assigned, usage: usage() });
    }
    const remaining = records.filter(r => r.seq > body.afterSeq);
    const page = remaining.slice(0, 100);
    return Response.json({ v: 2, records: page, cursor: page.at(-1)?.seq ?? body.afterSeq,
      hasMore: remaining.length > 100, usage: usage() });
  };
  return { records, requests, fetcher };
}

test('catch-up yields, uploads edits between chunks, resumes after reload/failure, and converges with another device', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const original = newOperation('add-entry', { entryId: 'reading', timestamp: 1700000000000, kg: 3, afterFeed: false });
  const remote = server([original, ...Array.from({ length: 1099 }, (_, i) =>
    newOperation('update-entry', { ...original, opId: crypto.randomUUID(), type: 'update-entry', kg: 3 + i / 1000 }))]);
  const local = await open(t); await local.link(credential);
  await local.mutate('add-entry', original);
  await local.replaceEntry('reading', { timestamp: original.timestamp, kg: 9, afterFeed: false });
  let fail = false;
  const fetcher = async (url, options) => {
    if (fail && JSON.parse(options.body).afterSeq === 1200) throw new Error('Connection lost');
    return remote.fetcher(url, options);
  };
  const engine = new SyncEngine(local, { fetcher });
  await engine.run();
  assert.equal(remote.requests.length, 6);
  assert.ok(remote.requests[4].url.endsWith('/append'), 'uploads before finishing history');
  let state = await local.read();
  assert.equal(state.sync.cursor, 1000);
  assert.equal(state.sync.downloaded, 500);
  assert.equal(state.pending.length, 0);
  assert.equal(visibleState(state).entries[0].kg, 9, 'older downloaded edits cannot overwrite the acknowledged edit');
  assert.match(catchUpStatus(state.sync), /500 changes downloaded/);
  const reloaded = await open(t, local.db.name);
  const resumed = new SyncEngine(reloaded, { fetcher });
  await resumed.run({ force: true });
  assert.equal(remote.requests.length, 6, 'reload and force preserve pacing');
  now += 15000; fail = true;
  await resumed.run();
  assert.equal((await reloaded.read()).sync.cursor, 1200, 'successful pages survive the failed request');
  fail = false;
  await resumed.run({ force: true });
  assert.equal(remote.requests[7].afterSeq, 1200, 'retry resumes instead of downloading from zero');
  const other = await open(t); await other.link(credential);
  const otherEngine = new SyncEngine(other, { fetcher: remote.fetcher, lockName: 'other-device' });
  for (let i = 0; i < 4; i++) { now += 15000; await Promise.all([resumed.run(), otherEngine.run()]); }
  await other.replaceEntry('reading', { timestamp: original.timestamp, kg: 7, afterFeed: false });
  await otherEngine.run(); await resumed.run();
  for (const log of [reloaded, other]) {
    state = await log.read();
    assert.equal(visibleState(state).entries[0].kg, 7);
    assert.equal(state.sync.catchingUp, false);
    assert.equal(state.sync.downloaded, remote.records.length);
    assert.equal(state.pending.length, 0);
  }
});

test('a 50,000-operation history completes over bounded chunks without the old 200-page ceiling', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const remote = server(Array.from({ length: 50000 }, (_, i) => setting(i % 1000)));
  const local = await open(t); await local.link(credential);
  const engine = new SyncEngine(local, { fetcher: remote.fetcher });
  for (let i = 0; i < 100; i++) {
    const before = remote.requests.length;
    await engine.run();
    assert.equal(remote.requests.length - before, 5);
    now += 15000;
  }
  const state = await local.read();
  assert.equal(state.sync.cursor, 100000);
  assert.equal(state.sync.downloaded, 50000);
  assert.equal(state.sync.catchingUp, false);
  assert.equal(visibleState(state).settings.diaperGrams, 999);
  assert.match(capacityWarning(state.sync), /storage full/);
});

test('Retry-After seconds and HTTP dates survive reload, cannot be forced, and resume at the committed cursor', async t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  for (const format of ['seconds', 'date']) {
    const local = await open(t); await local.link(credential);
    const remote = server(Array.from({ length: 250 }, (_, i) => setting(i)));
    let limited = true, requests = 0;
    const fetcher = async (url, options) => {
      requests++;
      if (limited && JSON.parse(options.body).afterSeq === 200) return Response.json({ error: 'Rate limited' }, {
        status: 429, headers: { 'Retry-After': format === 'seconds' ? '60' : new Date(now + 60000).toUTCString() },
      });
      return remote.fetcher(url, options);
    };
    const engine = new SyncEngine(local, { fetcher });
    await engine.run();
    assert.equal((await local.read()).sync.cursor, 200);
    assert.equal(requests, 2);
    const reopened = await open(t, local.db.name), resumed = new SyncEngine(reopened, { fetcher });
    now += 59000;
    await resumed.run({ force: true });
    await assert.rejects(resumed.connect(credential), /retry window/);
    assert.equal(requests, 2);
    now += 1000; limited = false;
    await resumed.run();
    assert.equal((await local.read()).sync.cursor, 500);
    assert.equal((await local.read()).sync.catchingUp, false);
  }
});

test('overlapping pages do not double-count progress or regress capacity; invalid metadata rolls back', async t => {
  const local = await open(t); await local.link(credential);
  const remote = server([setting(1), setting(2)]);
  const page = await (await remote.fetcher('/pull', { body: JSON.stringify({ afterSeq: 0 }) })).json();
  await local.applyPage(credential, 0, page);
  await local.applyPage(credential, 0, page);
  assert.equal((await local.read()).sync.downloaded, 2);
  const before = await local.read();
  await assert.rejects(local.applyPage(credential, 0, { ...page, usage: { count: -1, limit: 50000 } }));
  assert.deepEqual(await local.read(), before);
  assert.equal(capacityWarning({ usage: { count: 39999, limit: 50000 } }), '');
  assert.match(capacityWarning({ usage: { count: 40000, limit: 50000 } }), /nearly full/);
});

test('a delayed end-of-history response cannot report completion before an acknowledged upload is pulled', async t => {
  const local = await open(t); await local.link(credential);
  await local.mutate('set-setting', { field: 'sex', value: 'female' });
  const sent = (await local.read()).pending;
  await local.acknowledge(credential, sent, { v: 2, assigned: [{ opId: sent[0].opId, seq: 10 }] });
  await local.applyPage(credential, 0, { v: 2, records: [], cursor: 0, hasMore: false });
  assert.equal((await local.read()).sync.catchingUp, true);
  assert.equal((await local.read()).sync.syncedAt, null);
  await local.applyPage(credential, 0, { v: 2, records: [{ seq: 10, op: sent[0] }], cursor: 10, hasMore: false });
  assert.equal((await local.read()).sync.catchingUp, false);
});

test('concurrent tabs without a shared network lock preserve progress and share chunk cooldowns', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const local = await open(t), tab = await open(t, local.db.name);
  await local.link(credential);
  const remote = server(Array.from({ length: 1200 }, (_, i) => setting(i % 1000)));
  const engines = [local, tab].map((log, i) => new SyncEngine(log, { fetcher: remote.fetcher, lockName: `unshared-${i}` }));
  await Promise.all(engines.map(engine => engine.run()));
  const before = remote.requests.length;
  await Promise.all(engines.map(engine => engine.run({ force: true })));
  assert.equal(remote.requests.length, before);
  for (let i = 0; i < 3; i++) { now += 15000; await Promise.all(engines.map(engine => engine.run())); }
  const state = await local.read();
  assert.equal(state.sync.downloaded, 1200);
  assert.equal(state.sync.cursor, 2400);
  assert.equal(state.sync.catchingUp, false);
  assert.deepEqual(state, await tab.read());
});

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { NursingLog, NursingSync, nursingView } from '../breastfeeding-sync.js';
import { canonicalOperation, newOperation } from '../breastfeeding-protocol.js';
import { emptyFeed, switchSide, pause } from '../breastfeeding-timer.js';
import { startBackend } from './fixture.js';
let mf;
const logs = [];
before(async () => { ({ mf } = await startBackend()); });
after(async () => { logs.forEach(log => log.close()); await mf?.dispose(); });
async function open(name = crypto.randomUUID()) {
  const log = await NursingLog.open({ name, broadcast: false }); logs.push(log); return log;
}
const view = async log => nursingView(await log.read());
const fetcher = (url, options) => mf.dispatchFetch(`http://localhost${url}`, { ...options, headers: { ...options.headers, 'CF-Connecting-IP': crypto.randomUUID() } });
const engine = log => new NursingSync(log, { fetcher });
const start = (log, side, now) => log.update(s => { s.current = switchSide(s.current, side, now); });
const save = (log, now) => log.update(s => { s.feeds.push(pause(s.current, now)); s.current = emptyFeed(); });

test('start on A, switch/pause/edit on B, resume A, save B; edit and delete converge', async () => {
  const a = await open(), b = await open(), sa = engine(a), sb = engine(b);
  const key = await sa.create(); await sb.connect(key);
  await start(a, 'left', 1000); await sa.cycle(); await sb.cycle();
  assert.equal((await view(b)).current.active, 'left');
  await start(b, 'right', 6000); await sb.cycle(); await sa.cycle();
  assert.equal((await view(a)).current.left, 5000);
  await b.update(s => { s.current = pause(s.current, 14000); });
  await sb.cycle(); await sa.cycle();
  assert.equal((await view(a)).current.right, 8000);
  await b.update(s => { s.current.left = 60000; s.current.start = 0; });
  await sb.cycle(); await sa.cycle();
  await start(a, 'left', 20000); await sa.cycle(); await sb.cycle();
  await save(b, 23000); await sb.cycle(); await sa.cycle();
  assert.deepEqual(await view(a), await view(b));
  assert.equal((await view(a)).current.start, null);
  assert.equal((await view(a)).feeds[0].left, 63000);
  assert.equal((await view(a)).feeds[0].start, 0);
  await a.update(s => { s.feeds[0].right = 9000; }); await sa.cycle(); await sb.cycle();
  assert.equal((await view(b)).feeds[0].right, 9000);
  await b.update(s => { s.feeds = []; }); await sb.cycle(); await sa.cycle();
  assert.equal((await view(a)).feeds.length, 0);
});

test('offline stale timer updates never resurrect a saved or reset session', async () => {
  for (const finish of ['save', 'reset']) {
    const a = await open(), b = await open(), sa = engine(a), sb = engine(b);
    const key = await sa.create(); await sb.connect(key);
    await start(a, 'left', 1000); await sa.cycle(); await sb.cycle();
    await start(b, 'right', 3000); // B is offline: its newer running snapshot stays queued.
    if (finish === 'save') await save(a, 5000);
    else await a.update(s => { s.current = emptyFeed(); });
    await sa.cycle(); await sb.cycle(); await sa.cycle();
    assert.deepEqual(await view(a), await view(b));
    assert.equal((await view(b)).current.start, null);
    assert.equal((await view(b)).feeds.length, finish === 'save' ? 1 : 0);
    assert.equal((await b.read()).pending.length, 0);
  }
});

test('lost append response retries identical IDs and does not duplicate saves', async () => {
  const log = await open();
  let lose = true;
  const sync = new NursingSync(log, { fetcher: async (url, options) => {
    const result = await fetcher(url, options);
    if (url.endsWith('/append') && lose) { lose = false; throw new Error('Response lost'); }
    return result;
  } });
  await sync.create(); await start(log, 'left', 1000); await save(log, 5000);
  await assert.rejects(sync.cycle(), /Response lost/);
  const pending = (await log.read()).pending.map(op => op.opId);
  assert.equal(pending.length, 2);
  await sync.cycle();
  assert.equal((await log.read()).pending.length, 0);
  assert.equal((await view(log)).feeds.length, 1);
  const other = await open(); const second = engine(other);
  await second.connect((await log.read()).sync.key); await second.cycle();
  assert.deepEqual(await view(log), await view(other));
});

test('migration preserves local history and a running timer exactly once', async () => {
  const name = crypto.randomUUID();
  const feed = { ...pause(switchSide(emptyFeed(), 'left', 1000), 4000), id: crypto.randomUUID() };
  const current = switchSide(emptyFeed(), 'right', 5000);
  await new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('log');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction('log', 'readwrite');
      tx.objectStore('log').put({ feeds: [feed], current }, 'state');
      tx.oncomplete = () => { r.result.close(); resolve(); };
    };
  });
  const log = await open(name);
  assert.deepEqual((await view(log)).feeds, [feed]);
  assert.equal((await view(log)).current.since, 5000);
  assert.equal((await log.read()).pending.length, 2);
  const reopened = await open(name);
  assert.deepEqual(await view(log), await view(reopened));
  assert.equal((await reopened.read()).pending.length, 2);
});

test('concurrent edits resolve by server sequence; terminal actions and drafts survive', async () => {
  const a = await open(), b = await open(), sa = engine(a), sb = engine(b);
  const key = await sa.create(); await sb.connect(key);
  await start(a, 'left', 1000); await start(b, 'right', 2000);
  await sa.cycle(); await sb.cycle(); await sa.cycle();
  assert.deepEqual(await view(a), await view(b));
  assert.equal((await view(a)).drafts.length, 1, 'independent offline starts are both retained');
  const draft = (await view(a)).drafts[0];
  await a.selectDraft(draft.id); await sa.cycle(); await sb.cycle();
  assert.equal((await view(b)).current.id, draft.id);
  await a.update(s => { s.current = pause(s.current, 5000); s.current.left = 7000; });
  await b.update(s => { s.current = pause(s.current, 5000); s.current.left = 9000; });
  await sa.cycle(); await sb.cycle(); await sa.cycle();
  assert.equal((await view(a)).current.left, 9000);
  assert.deepEqual(await view(a), await view(b));
});

test('storage failure is atomic, malformed pages preserve cursor, older ack cannot revert timer', async () => {
  const log = await open();
  await assert.rejects(log.update(s => { s.current = switchSide(s.current, 'left', 1000); throw new Error('failed write'); }));
  assert.equal((await log.read()).pending.length, 0);
  const key = `nf1.${crypto.randomUUID()}.${'a'.repeat(64)}`;
  await log.link(key); await start(log, 'left', 1000);
  const old = (await log.read()).pending[0];
  const later = newOperation('nursing-state', old.sessionId, switchSide(old.feed, 'right', 5000));
  const page = { v: 2, records: [{ seq: 2, op: later }], cursor: 2, hasMore: false };
  await log.applyPage(key, 0, page);
  await log.acknowledge(key, [old], { v: 2, assigned: [{ opId: old.opId, seq: 1 }] });
  assert.equal((await view(log)).current.active, 'right');
  await assert.rejects(async () => log.applyPage(key, 2, { ...page, records: [{ seq: 3, op: { ...later, feed: {} } }], cursor: 3 }));
  assert.equal((await log.read()).sync.cursor, 2);
});

test('nursing API isolates weight keys, validates snapshots and authenticates writes', async () => {
  const log = await open(), sync = engine(log); const key = await sync.create();
  const call = (path, key, body) => fetcher(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ v: 2, ...body }) });
  assert.equal((await call('/api/sync/pull', key, { afterSeq: 0 })).status, 401);
  assert.equal((await call('/api/nursing-sync/pull', 'wrong words cannot connect', { afterSeq: 0 })).status, 401);
  const op = newOperation('nursing-state', crypto.randomUUID(), switchSide(emptyFeed(), 'left', 1000));
  assert.equal((await call('/api/nursing-sync/append', key, { ops: [{ ...op, feed: { ...op.feed, left: -1 } }] })).status, 400);
  assert.equal((await call('/api/nursing-sync/append', key, { ops: [op] })).status, 200);
  assert.equal((await call('/api/nursing-sync/append', key, { ops: [{ ...op, feed: { ...op.feed, left: 100 } }] })).status, 409);
  assert.throws(() => canonicalOperation({ ...op, sessionId: 12 }));
  assert.throws(() => canonicalOperation({ ...op, feed: { ...op.feed, since: null } }));
});


test('resetting an offline timer cannot delete a feed saved on another device', async () => {
  const a = await open(), b = await open(), sa = engine(a), sb = engine(b);
  const key = await sa.create(); await sb.connect(key);
  await start(a, 'left', 1000); await sa.cycle(); await sb.cycle();
  await save(a, 5000); await sa.cycle();
  await b.update(s => { s.current = emptyFeed(); });
  await sb.cycle(); await sa.cycle();
  assert.equal((await view(a)).feeds.length, 1);
  assert.equal((await view(a)).current.start, null);
  assert.deepEqual(await view(a), await view(b));
});

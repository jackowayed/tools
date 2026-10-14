import { VERSION, MAX_BATCH, canonicalOperation, entryPayload, newOperation, parseKey, validBirth } from './sync-protocol.js';

const DEFAULT_SETTINGS = { birth: '', sex: '', unit: 'lb' };
function initialState(legacy) {
  const state = { revision: 0, entries: [], tombstones: [], pending: [],
    settings: { ...DEFAULT_SETTINGS }, versions: { birth: 0, sex: 0 }, sync: null };
  for (const entry of legacy.entries || []) {
    const entryId = /^[A-Za-z0-9_-]{1,100}$/.test(entry.id || '') ? entry.id : crypto.randomUUID();
    const op = newOperation('add-entry', { entryId, timestamp: Math.trunc(entry.ts), kg: entry.kg, afterFeed: entry.afterFeed === true, clothed: entry.clothed === true });
    applyOperation(state, op);
    state.pending.push(op);
  }
  for (const field of ['birth', 'sex']) {
    const value = legacy.settings?.[field];
    if (field === 'birth' ? typeof value === 'string' && validBirth(value) : ['', 'male', 'female'].includes(value)) {
      if (value) state.pending.push(newOperation('set-setting', { field, value }));
    }
  }
  if (legacy.settings?.unit === 'kg') state.settings.unit = 'kg';
  return state;
}

function applyOperation(state, op, seq = 0) {
  if (op.type === 'add-entry') {
    const existing = state.entries.find(e => e.id === op.entryId);
    if (existing) {
      if (entryPayload({ entryId: existing.id, timestamp: existing.ts, kg: existing.kg, afterFeed: existing.afterFeed, clothed: existing.clothed }) !== entryPayload(op))
        throw new Error('Conflicting entry received. Sync stopped; local data was kept.');
    } else state.entries.push({ type: 'weight', id: op.entryId, ts: op.timestamp, kg: op.kg, afterFeed: op.afterFeed, clothed: op.clothed === true });
  } else if (op.type === 'delete-entry') {
    if (!state.tombstones.includes(op.entryId)) state.tombstones.push(op.entryId);
  } else if (seq > state.versions[op.field]) {
    state.settings[op.field] = op.value;
    state.versions[op.field] = seq;
  }
}

export function visibleState(state) {
  const deleted = new Set(state.tombstones);
  const settings = { ...state.settings };
  for (const op of state.pending) if (op.type === 'set-setting') settings[op.field] = op.value;
  return { ...state, entries: state.entries.filter(e => !deleted.has(e.id)), settings };
}

export class LocalLog {
  constructor(db, channel) { this.db = db; this.channel = channel; this.listeners = new Set(); }
  static async open({ name = 'baby-weight-v1', legacy = {}, broadcast = true } = {}) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other baby-weight tabs and try again.'));
    });
    const channel = broadcast && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`${name}:changes`) : null;
    const log = new LocalLog(db, channel);
    db.onversionchange = () => db.close();
    if (channel) channel.onmessage = () => log.notify(false);
    // Migration and its marker are committed together; other tabs see the winner.
    try {
      const state = await log.change(state => state || initialState(typeof legacy === 'function' ? legacy() : legacy));
      log.resetId = state.resetId ?? null;
      return log;
    } catch (error) { log.close(); throw error; }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(broadcast = true) {
    if (broadcast) this.channel?.postMessage('changed');
    for (const listener of this.listeners) listener();
  }
  read() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('current');
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error('Could not read local data.'));
      tx.onerror = () => {};
    });
  }
  change(update) {
    return new Promise((resolve, reject) => {
      // All tabs serialize at this readwrite transaction. Never save a stale UI snapshot.
      const tx = this.db.transaction('state', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('state');
      const request = store.get('current');
      let next, failure;
      request.onsuccess = () => {
        try {
          if (this.resetId !== undefined && (request.result?.resetId ?? null) !== this.resetId)
            throw new Error('This client was reset. Reload this page.');
          next = update(request.result);
          next.revision++;
          store.put(next, 'current');
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => { this.notify(); resolve(next); };
      tx.onabort = () => reject(failure || tx.error || new Error('Could not save on this device.'));
      tx.onerror = () => {};
    });
  }
  mutate(type, fields) {
    const op = newOperation(type, fields);
    return this.change(state => {
      applyOperation(state, op);
      state.pending.push(op);
      return state;
    });
  }
  replaceEntry(entryId, fields) {
    // Use the existing sync protocol: queue both changes in one durable transaction.
    const removed = newOperation('delete-entry', { entryId });
    const replacement = newOperation('add-entry', { ...fields, entryId: crypto.randomUUID() });
    return this.change(state => {
      if (!state.entries.some(e => e.id === entryId) || state.tombstones.includes(entryId))
        throw new Error('This weigh-in was removed or edited elsewhere. Cancel and reopen the entry.');
      for (const op of [removed, replacement]) {
        applyOperation(state, op);
        state.pending.push(op);
      }
      return state;
    });
  }
  setUnit(unit) {
    if (!['kg', 'lb'].includes(unit)) throw new Error('Invalid unit.');
    return this.change(state => { state.settings.unit = unit; return state; });
  }
  link(key, { created = false, discardSettingIds = null } = {}) {
    const auth = parseKey(key);
    return this.change(state => {
      if (state.sync && state.sync.key !== auth.key) throw new Error('This browser is already linked to a different dataset. Reconnect with its original key.');
      if (!state.sync) {
        if (!created) {
          // Joining imports entries and tombstones, but not old/default baby settings.
          state.pending = state.pending.filter(op => op.type !== 'set-setting'
            || (discardSettingIds !== null && !discardSettingIds.includes(op.opId)));
          state.settings.birth = ''; state.settings.sex = '';
          state.versions = { birth: 0, sex: 0 };
        }
        state.sync = { ...auth, cursor: 0, syncedAt: null };
      }
      state.sync.enabled = true;
      return state;
    });
  }
  reset() {
    // Replace local state directly: never queue deletions or settings for sync.
    return this.change(state => ({ ...initialState({}), revision: state.revision, resetId: crypto.randomUUID() }));
  }
  disconnect() {
    return this.change(state => { if (state.sync) state.sync.enabled = false; return state; });
  }
  applyPage(key, afterSeq, page) {
    if (page.v !== VERSION || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('Invalid sync response.');
    let last = afterSeq;
    const records = page.records.map(record => {
      if (!Number.isSafeInteger(record.seq) || record.seq <= last) throw new Error('Invalid sync sequence.');
      last = record.seq;
      return { seq: record.seq, op: canonicalOperation(record.op) };
    });
    if (page.cursor !== last || (page.hasMore && !records.length)) throw new Error('Invalid sync cursor.');
    return this.change(state => {
      if (state.sync?.key !== key) throw new Error('Dataset changed.');
      for (const record of records) {
        if (record.seq <= state.sync.cursor) continue;
        applyOperation(state, record.op, record.seq);
      }
      // Another tab may already have committed this page or a later one.
      state.sync.cursor = Math.max(state.sync.cursor, page.cursor);
      if (!page.hasMore) state.sync.syncedAt = Date.now();
      return state;
    });
  }
  acknowledge(key, sent, response) {
    if (response.v !== VERSION || !Array.isArray(response.assigned) || response.assigned.length !== sent.length) throw new Error('Invalid append acknowledgement.');
    const assigned = new Map(response.assigned.map(a => [a.opId, a.seq]));
    if (assigned.size !== sent.length || sent.some(op => !Number.isSafeInteger(assigned.get(op.opId)) || assigned.get(op.opId) < 1))
      throw new Error('Incomplete append acknowledgement.');
    return this.change(state => {
      if (state.sync?.key !== key) throw new Error('Dataset changed.');
      for (const op of sent) applyOperation(state, op, assigned.get(op.opId));
      state.pending = state.pending.filter(op => !assigned.has(op.opId));
      // Acknowledging our own writes says nothing about intervening remote operations.
      return state;
    });
  }
  close() { this.channel?.close(); this.db.close(); }
}

export class SyncEngine {
  constructor(log, { fetcher = globalThis.fetch.bind(globalThis), onStatus = () => {} } = {}) {
    this.log = log; this.fetcher = fetcher; this.onStatus = onStatus;
    this.running = null; this.failures = 0; this.nextAttempt = 0;
  }
  async request(action, body, key) {
    const response = await this.fetcher(`/api/sync/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ v: VERSION, ...body }), signal: AbortSignal.timeout(15000), cache: 'no-store',
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('Sync server returned an invalid response.'); }
    if (!response.ok) throw new Error(data.error || `Sync failed (${response.status}).`);
    if (data.v !== VERSION) throw new Error('Unsupported sync server version.');
    return data;
  }
  async create() {
    const state = await this.log.read();
    if (state.sync) throw new Error('This browser already has a sync key. Use Reconnect.');
    const data = await this.request('create', {});
    await this.log.link(data.key, { created: true });
    return data.key;
  }
  async connect(key) {
    const auth = parseKey(key);
    const state = await this.log.read();
    if (state.sync && state.sync.key !== auth.key) throw new Error('Use this browser’s original sync key. Switching datasets is not supported.');
    // Authenticate before binding local work or discarding initial local settings.
    await this.request('pull', { afterSeq: 0 }, auth.key);
    await this.log.link(auth.key, { discardSettingIds: state.pending.filter(op => op.type === 'set-setting').map(op => op.opId) });
  }
  async pull(key) {
    for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
      const state = await this.log.read();
      if (!state.sync?.enabled || state.sync.key !== key) return;
      const afterSeq = state.sync.cursor;
      const page = await this.request('pull', { afterSeq }, key);
      await this.log.applyPage(key, afterSeq, page);
      if (!page.hasMore) return;
    }
    throw new Error('Sync history is too large. Local data was kept.');
  }
  async cycle() {
    const state = await this.log.read();
    if (!state.sync?.enabled) return;
    const key = state.sync.key;
    this.onStatus('Syncing…');
    await this.pull(key);
    // Bound a cycle so a busy producer cannot monopolize the tab indefinitely.
    for (let batch = 0; batch < 10; batch++) {
      const latest = await this.log.read();
      if (!latest.sync?.enabled || latest.sync.key !== key) return;
      const sent = latest.pending.slice(0, MAX_BATCH);
      if (!sent.length) break;
      const response = await this.request('append', { ops: sent }, key);
      await this.log.acknowledge(key, sent, response);
    }
    await this.pull(key);
  }
  run({ force = false } = {}) {
    if (this.running) return this.running;
    if (!force && Date.now() < this.nextAttempt) return Promise.resolve();
    this.running = (async () => {
      try {
        if (globalThis.navigator?.locks) {
          await navigator.locks.request('baby-weight-sync', { ifAvailable: true }, lock => lock ? this.cycle() : undefined);
        } else await this.cycle();
        this.failures = 0; this.nextAttempt = 0; this.onStatus('');
      } catch (error) {
        this.failures++;
        this.nextAttempt = Date.now() + Math.min(300000, 2000 * 2 ** Math.min(this.failures, 7)) * (0.8 + Math.random() * 0.4);
        this.onStatus(error.message);
      } finally { this.running = null; }
    })();
    return this.running;
  }
}

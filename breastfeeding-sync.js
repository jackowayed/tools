import { LocalLog, SyncEngine } from './sync-client.js';
import { VERSION, canonicalOperation, newOperation, parseKey } from './breastfeeding-protocol.js';
import { emptyFeed } from './breastfeeding-timer.js';

const initial = () => ({ revision: 0, sessions: {}, pending: [], sync: null });
function apply(state, op, seq) {
  const session = state.sessions[op.sessionId] ||= {};
  // Save/reset/delete permanently end this session's timer, even when an old
  // offline device later uploads another running snapshot. Edits remain possible.
  if (op.type === 'nursing-delete') session.deleted = true;
  else if (op.type === 'nursing-reset') session.reset = true;
  else {
    const field = { 'nursing-state': 'timer', 'nursing-save': 'saved', 'nursing-edit': 'edit' }[op.type];
    if (seq > (session[field]?.seq || 0)) session[field] = { seq, feed: op.feed };
  }
}
export function nursingView(state) {
  const projected = { sessions: structuredClone(state.sessions) };
  state.pending.forEach((op, i) => apply(projected, op, Number.MAX_SAFE_INTEGER - state.pending.length + i));
  const feeds = [], drafts = [];
  for (const [id, session] of Object.entries(projected.sessions)) {
    if (session.deleted) continue;
    if (session.saved) {
      const latest = (session.edit?.seq || 0) > session.saved.seq ? session.edit : session.saved;
      feeds.push({ ...latest.feed, id });
    } else if (session.timer && !session.reset) drafts.push({ ...session.timer.feed, id, order: session.timer.seq });
  }
  drafts.sort((a, b) => b.order - a.order || b.id.localeCompare(a.id));
  const clean = ({ order, ...feed }) => feed;
  return { current: drafts.length ? clean(drafts[0]) : emptyFeed(), feeds, drafts: drafts.slice(1).map(clean) };
}

export class NursingLog extends LocalLog {
  static async open({ name = 'breastfeeding-log-v1', broadcast = true } = {}) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      let failure;
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('state');
        const migrate = legacy => {
          try {
            const state = initial();
            for (const feed of legacy?.feeds || []) state.pending.push(newOperation('nursing-save', feed.id, feed));
            if (legacy?.current?.start !== null && legacy?.current?.start !== undefined)
              state.pending.push(newOperation('nursing-state', crypto.randomUUID(), legacy.current));
            store.put(state, 'current');
          } catch (error) { failure = error; request.transaction.abort(); }
        };
        // Read the previous local-only state in the same upgrade transaction.
        // Keep its store as a backup, but never import it a second time.
        if (request.result.objectStoreNames.contains('log')) {
          const old = request.transaction.objectStore('log').get('state');
          old.onsuccess = () => migrate(old.result);
        } else migrate(null);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(failure || request.error);
      request.onblocked = () => reject(new Error('Close other nursing tabs and reload to upgrade storage.'));
    });
    const channel = broadcast && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`${name}:changes`) : null;
    const log = new NursingLog(db, channel);
    log.resetId = null;
    db.onversionchange = () => { db.close(); log.notify(false); };
    if (channel) channel.onmessage = () => log.notify(false);
    return log;
  }
  update(change) {
    return this.change(state => {
      const before = nursingView(state);
      const after = structuredClone(before);
      change(after);
      const queue = (type, id, feed) => state.pending.push(newOperation(type, id, feed));
      for (const feed of after.feeds) {
        const old = before.feeds.find(f => f.id === feed.id);
        if (!old) queue('nursing-save', feed.id, feed);
        else if (JSON.stringify(feed) !== JSON.stringify(old)) queue('nursing-edit', feed.id, feed);
      }
      for (const feed of before.feeds) if (!after.feeds.some(f => f.id === feed.id)) queue('nursing-delete', feed.id);
      if (JSON.stringify(before.current) !== JSON.stringify(after.current)) {
        if (after.current.start !== null) queue('nursing-state', after.current.id || crypto.randomUUID(), after.current);
        else if (before.current.id && !after.feeds.some(f => f.id === before.current.id)) queue('nursing-reset', before.current.id);
      }
      return state;
    });
  }
  selectDraft(id) {
    return this.change(state => {
      const view = nursingView(state);
      const feed = [view.current, ...view.drafts].find(f => f.id === id);
      if (!feed) throw new Error('This feed was finished elsewhere.');
      state.pending.push(newOperation('nursing-state', id, feed));
      return state;
    });
  }
  link(key) {
    const auth = parseKey(key);
    return this.change(state => {
      if (state.sync && state.sync.key !== auth.key) throw new Error('Reconnect with this device’s original nursing sync key.');
      state.sync ||= { ...auth, cursor: 0, syncedAt: null };
      state.sync.enabled = true;
      return state;
    });
  }
  applyPage(key, afterSeq, page) {
    if (page.v !== VERSION || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('Invalid nursing sync response.');
    let last = afterSeq;
    const records = page.records.map(record => {
      if (!Number.isSafeInteger(record.seq) || record.seq <= last) throw new Error('Invalid nursing sequence.');
      last = record.seq;
      return { seq: record.seq, op: canonicalOperation(record.op) };
    });
    if (page.cursor !== last || (page.hasMore && !records.length)) throw new Error('Invalid nursing cursor.');
    return this.change(state => {
      if (state.sync?.key !== key) throw new Error('Dataset changed.');
      for (const { op, seq } of records) if (seq > state.sync.cursor) apply(state, op, seq);
      state.sync.cursor = Math.max(state.sync.cursor, page.cursor);
      if (!page.hasMore) state.sync.syncedAt = Date.now();
      return state;
    });
  }
  acknowledge(key, sent, response) {
    if (response.v !== VERSION || !Array.isArray(response.assigned) || response.assigned.length !== sent.length) throw new Error('Invalid nursing acknowledgement.');
    const assigned = new Map(response.assigned.map(a => [a.opId, a.seq]));
    if (assigned.size !== sent.length || sent.some(op => !Number.isSafeInteger(assigned.get(op.opId)) || assigned.get(op.opId) < 1)) throw new Error('Incomplete nursing acknowledgement.');
    return this.change(state => {
      if (state.sync?.key !== key) throw new Error('Dataset changed.');
      for (const op of sent) apply(state, op, assigned.get(op.opId));
      state.pending = state.pending.filter(op => !assigned.has(op.opId));
      return state;
    });
  }
}
export class NursingSync extends SyncEngine {
  constructor(log, options = {}) {
    super(log, { ...options, basePath: '/api/nursing-sync', parseCredential: parseKey, lockName: 'nursing-sync', createOptions: { credentialFormat: 'passphrase' } });
  }
}

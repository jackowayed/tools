import { VERSION, MAX_BATCH, PAGE_SIZE, canonicalOperation, entryPayload, parseKey } from '../sync-protocol.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) { await reader.cancel(); throw new Error('Request too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || body.v !== VERSION) throw new Error('Sync has been updated. Reload this page to continue; local changes were kept.');
  return body;
}

async function rateAllowed(db, request, creating) {
  const now = Math.floor(Date.now() / 1000);
  const span = creating ? 3600 : 60;
  const window = Math.floor(now / span) * span;
  const key = await digest(`${creating ? 'create' : 'sync'}:${request.headers.get('CF-Connecting-IP') || 'local'}`);
  const result = await db.prepare(`INSERT INTO sync_rate_limits(key, window, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END,
      window = excluded.window RETURNING count`).bind(key, window).first();
  // Bound retention without logging addresses or keeping historical windows.
  await db.prepare('DELETE FROM sync_rate_limits WHERE window < ?').bind(now - 7200).run();
  return result.count <= (creating ? 5 : 120);
}

export async function handleSync(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/api/sync/create', '/api/sync/append', '/api/sync/pull'].includes(path)) return json({ error: 'Not found.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!env.SYNC_DB) return json({ error: 'Sync is not configured on this server.' }, 503);
  // No cross-origin browser writes, including unauthenticated dataset creation.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin not allowed.' }, 403);
  try {
    const db = env.SYNC_DB;
    const creating = path.endsWith('/create');
    if (!await rateAllowed(db, request, creating)) return json({ error: 'Too many requests. Try again later.' }, 429);
    let body;
    try { body = await readBody(request); } catch (error) { return json({ error: error.message }, 400); }
    if (creating) {
      const id = crypto.randomUUID();
      const key = `bw1.${id}.${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      await db.prepare('INSERT INTO datasets(id, credential_hash, created_at) VALUES (?, ?, ?)')
        .bind(id, await digest(key), Date.now()).run();
      return json({ v: VERSION, datasetId: id, key }, 201);
    }
    let auth;
    try {
      const header = request.headers.get('authorization') || '';
      if (!header.startsWith('Bearer ')) throw new Error('Missing bearer credential.');
      auth = parseKey(header.slice(7));
    }
    catch { return json({ error: 'Invalid sync key.' }, 401); }
    const dataset = await db.prepare('SELECT id FROM datasets WHERE id = ? AND credential_hash = ?')
      .bind(auth.datasetId, await digest(auth.key)).first();
    if (!dataset) return json({ error: 'Invalid sync key.' }, 401);

    if (path.endsWith('/pull')) {
      if (!Number.isSafeInteger(body.afterSeq) || body.afterSeq < 0) return json({ error: 'Invalid cursor.' }, 400);
      const { results } = await db.prepare('SELECT seq, payload FROM operations WHERE dataset_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(dataset.id, body.afterSeq, PAGE_SIZE + 1).all();
      const records = results.slice(0, PAGE_SIZE).map(row => ({ seq: row.seq, op: JSON.parse(row.payload) }));
      return json({ v: VERSION, records, cursor: records.at(-1)?.seq ?? body.afterSeq, hasMore: results.length > PAGE_SIZE });
    }
    let ops;
    try {
      if (!Array.isArray(body.ops) || !body.ops.length || body.ops.length > MAX_BATCH) throw new Error('Send 1–50 operations.');
      ops = body.ops.map(canonicalOperation);
    } catch (error) { return json({ error: error.message }, 400); }
    const statements = [];
    for (const op of ops) {
      statements.push(db.prepare(`INSERT INTO operations(dataset_id, op_id, payload, entry_id, entry_payload, received_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dataset_id, op_id) DO NOTHING`)
        .bind(dataset.id, op.opId, JSON.stringify(op), op.type === 'add-entry' ? op.entryId : null,
          op.type === 'add-entry' ? entryPayload(op) : null, Date.now()));
      statements.push(db.prepare('SELECT seq, op_id AS opId FROM operations WHERE dataset_id = ? AND op_id = ?')
        .bind(dataset.id, op.opId));
    }
    // D1 executes this fixed batch transactionally. No JS read/modify/write counter.
    const results = await db.batch(statements);
    return json({ v: VERSION, assigned: results.filter((_, i) => i % 2 === 1).map(r => r.results[0]) });
  } catch (error) {
    const message = String(error.message);
    if (message.includes('op_conflict') || message.includes('entry_conflict'))
      return json({ error: 'An operation or entry ID was reused with different content. Pending changes were kept.' }, 409);
    if (message.includes('dataset_full')) return json({ error: 'This dataset has reached its storage limit. Pending changes were kept.' }, 413);
    // Do not log D1 exceptions: they may contain bound health data or credentials.
    return json({ error: 'Sync is temporarily unavailable. Your local changes are safe.' }, 503);
  }
}

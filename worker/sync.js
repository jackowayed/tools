import { generatePassphrase } from '../sync-passphrase.js';
import { VERSION, MAX_BATCH, PAGE_SIZE, canonicalOperation, entryPayload, parseKey } from '../sync-protocol.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
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

async function retryAfterSeconds(db, request, creating) {
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
  return result.count <= (creating ? 5 : 120) ? 0 : window + span - now;
}

export async function handleSync(request, env, protocol = { canonicalOperation, parseKey }, prefix = '/api/sync', keyPrefix = 'bw1') {
  const path = new URL(request.url).pathname;
  if (![`${prefix}/create`, `${prefix}/append`, `${prefix}/pull`].includes(path)) return json({ error: 'Not found.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!env.SYNC_DB) return json({ error: 'Sync is not configured on this server.' }, 503);
  // No cross-origin browser writes, including unauthenticated dataset creation.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin not allowed.' }, 403);
  try {
    const db = env.SYNC_DB;
    const creating = path.endsWith('/create');
    const retryAfter = await retryAfterSeconds(db, request, creating);
    if (retryAfter) return json({ error: 'Too many requests. Try again after the retry window.' }, 429, { 'retry-after': String(retryAfter) });
    let body;
    try { body = await readBody(request); } catch (error) { return json({ error: error.message }, 400); }
    const phraseDomain = keyPrefix === 'nf1' ? 'nursing-passphrase-v1' : 'weight-passphrase-v1';
    const phrasePrefix = keyPrefix === 'nf1' ? 'nf2' : 'bw2';
    if (creating) {
      if (body.credentialFormat !== undefined && (body.credentialFormat !== 'passphrase' || !['nf1', 'bw1'].includes(keyPrefix)))
        return json({ error: 'Unsupported credential format.' }, 400);
      if (body.credentialFormat === 'passphrase') {
        // A hash-derived primary key makes collisions atomic without a migration.
        // Never attach a newly created client to an existing dataset on collision.
        for (let attempt = 0; attempt < 5; attempt++) {
          const key = generatePassphrase();
          const hash = await digest(`${phraseDomain}:${key}`);
          const id = `${phrasePrefix}-${hash}`;
          const result = await db.prepare('INSERT INTO datasets(id, credential_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id')
            .bind(id, hash, Date.now()).first();
          if (result) return json({ v: VERSION, datasetId: id, key }, 201);
        }
        throw new Error('Could not allocate a new credential.');
      }
      // Older clients still receive a credential they understand.
      const id = crypto.randomUUID();
      const key = `${keyPrefix}.${id}.${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      await db.prepare('INSERT INTO datasets(id, credential_hash, created_at) VALUES (?, ?, ?)')
        .bind(id, await digest(key), Date.now()).run();
      return json({ v: VERSION, datasetId: id, key }, 201);
    }
    let auth;
    try {
      const header = request.headers.get('authorization') || '';
      if (!header.startsWith('Bearer ')) throw new Error('Missing bearer credential.');
      auth = protocol.parseKey(header.slice(7));
    }
    catch { return json({ error: 'Invalid sync credentials.' }, 401); }
    const credentialHash = await digest(auth.format === 'passphrase' ? `${phraseDomain}:${auth.key}` : auth.key);
    const datasetId = auth.format === 'passphrase' ? `${phrasePrefix}-${credentialHash}` : auth.datasetId;
    const dataset = await db.prepare('SELECT id FROM datasets WHERE id = ? AND credential_hash = ?')
      .bind(datasetId, credentialHash).first();
    if (!dataset) return json({ error: 'Invalid sync credentials.' }, 401);

    if (path.endsWith('/pull')) {
      if (!Number.isSafeInteger(body.afterSeq) || body.afterSeq < 0) return json({ error: 'Invalid cursor.' }, 400);
      // Read capacity and the page in one snapshot, including concurrent appends.
      const [history, capacity] = await db.batch([
        db.prepare('SELECT seq, payload FROM operations WHERE dataset_id = ? AND seq > ? ORDER BY seq LIMIT ?')
          .bind(dataset.id, body.afterSeq, PAGE_SIZE + 1),
        db.prepare('SELECT operation_count AS count, operation_limit AS "limit" FROM datasets WHERE id = ?').bind(dataset.id),
      ]);
      const records = history.results.slice(0, PAGE_SIZE).map(row => ({ seq: row.seq, op: JSON.parse(row.payload) }));
      return json({ v: VERSION, records, cursor: records.at(-1)?.seq ?? body.afterSeq,
        hasMore: history.results.length > PAGE_SIZE, usage: capacity.results[0] });
    }
    let ops;
    try {
      if (!Array.isArray(body.ops) || !body.ops.length || body.ops.length > MAX_BATCH) throw new Error('Send 1–50 operations.');
      ops = body.ops.map(protocol.canonicalOperation);
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
    statements.push(db.prepare('SELECT operation_count AS count, operation_limit AS "limit" FROM datasets WHERE id = ?').bind(dataset.id));
    const results = await db.batch(statements);
    return json({ v: VERSION, assigned: results.slice(0, -1).filter((_, i) => i % 2 === 1).map(r => r.results[0]), usage: results.at(-1).results[0] });
  } catch (error) {
    const message = String(error.message);
    if (message.includes('op_conflict') || message.includes('entry_conflict'))
      return json({ error: 'An operation or entry ID was reused with different content. Pending changes were kept.' }, 409);
    if (message.includes('dataset_full')) return json({ error: 'This dataset has reached its storage limit. Pending changes were kept.' }, 413);
    // Do not log D1 exceptions: they may contain bound health data or credentials.
    return json({ error: 'Sync is temporarily unavailable. Your local changes are safe.' }, 503);
  }
}

// Separate keys and routes keep nursing journals isolated from weight-log clients.
export const VERSION = 2;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
export function parseKey(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Enter the four-word sync passphrase or an existing nursing sync key.');
  const match = /^nf1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(value.trim());
  if (match) return { key: match[0], datasetId: match[1] };
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z]+(?:-[a-z]+)*(?: [a-z]+(?:-[a-z]+)*){3}$/.test(key)) throw new Error('Enter all four words, separated by spaces, or paste an existing nursing sync key.');
  // The server derives the dataset ID from a domain-separated credential hash.
  return { key, datasetId: null, format: 'passphrase' };
}
export function canonicalOperation(input) {
  if (!input || input.v !== VERSION || typeof input.opId !== 'string' || !ID.test(input.opId) || typeof input.sessionId !== 'string' || !ID.test(input.sessionId) || ['__proto__', 'constructor', 'prototype'].includes(input.sessionId)) throw new Error('Invalid nursing operation ID or version.');
  const op = { v: VERSION, opId: input.opId, type: input.type, sessionId: input.sessionId };
  if (!['nursing-state', 'nursing-save', 'nursing-edit', 'nursing-delete', 'nursing-reset'].includes(op.type)) throw new Error('Unknown nursing operation.');
  if (['nursing-delete', 'nursing-reset'].includes(op.type)) return op;
  const f = input.feed;
  const timestamp = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
  const duration = n => Number.isSafeInteger(n) && n >= 0 && n <= 86400000000;
  if (!f || !timestamp(f.start) || !duration(f.left) || !duration(f.right)
    || ![null, 'left', 'right'].includes(f.active) || ![null, 'left', 'right'].includes(f.last)
    || (f.active ? !timestamp(f.since) || f.since < f.start || f.last !== f.active : f.since !== null)) throw new Error('Invalid nursing timer.');
  if (op.type !== 'nursing-state' && (f.active !== null || f.left + f.right <= 0 || !f.last || f[f.last] <= 0)) throw new Error('Invalid saved feed.');
  op.feed = { start: f.start, left: f.left, right: f.right, active: f.active, since: f.since, last: f.last };
  return op;
}
export function newOperation(type, sessionId, feed) {
  return canonicalOperation({ v: VERSION, opId: crypto.randomUUID(), type, sessionId, feed });
}

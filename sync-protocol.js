// Shared, versioned wire format. Property order here defines canonical JSON.
export const VERSION = 1;
export const MAX_BATCH = 50;
export const PAGE_SIZE = 100;
export const MAX_OPERATIONS = 10000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const KEY = /^bw1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/;

export function parseKey(key) {
  const match = typeof key === 'string' && KEY.exec(key.trim());
  if (!match) throw new Error('Invalid sync key. Paste the complete key.');
  return { key: match[0], datasetId: match[1] };
}

export function validBirth(value) {
  return value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value);
}

export function canonicalOperation(input) {
  if (!input || input.v !== VERSION || typeof input.opId !== 'string' || !ID.test(input.opId)) throw new Error('Invalid operation version or ID.');
  const op = { v: VERSION, opId: input.opId, type: input.type };
  if (op.type === 'add-entry' || op.type === 'delete-entry') {
    if (typeof input.entryId !== 'string' || !ID.test(input.entryId)) throw new Error('Invalid entry ID.');
    op.entryId = input.entryId;
  }
  if (op.type === 'add-entry') {
    if (!Number.isSafeInteger(input.timestamp) || Math.abs(input.timestamp) > 8640000000000000
      || typeof input.kg !== 'number' || !Number.isFinite(input.kg) || input.kg <= 0 || input.kg > 50
      || typeof input.afterFeed !== 'boolean') throw new Error('Invalid weigh-in.');
    Object.assign(op, { timestamp: input.timestamp, kg: input.kg, afterFeed: input.afterFeed });
  } else if (op.type === 'set-setting') {
    if (input.field === 'birth' ? !validBirth(input.value)
      : input.field === 'sex' ? !['', 'male', 'female'].includes(input.value) : true) throw new Error('Invalid setting.');
    Object.assign(op, { field: input.field, value: input.value });
  } else if (op.type !== 'delete-entry') throw new Error('Unknown operation type.');
  return op;
}

export function entryPayload(op) {
  return JSON.stringify({ entryId: op.entryId, timestamp: op.timestamp, kg: op.kg, afterFeed: op.afterFeed });
}

export function newOperation(type, fields) {
  return canonicalOperation({ v: VERSION, opId: crypto.randomUUID(), type, ...fields });
}

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  operation_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  op_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  entry_id TEXT,
  entry_payload TEXT,
  received_at INTEGER NOT NULL,
  UNIQUE(dataset_id, op_id)
);
CREATE INDEX operations_dataset_seq ON operations(dataset_id, seq);
CREATE TABLE entry_ids (
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  entry_id TEXT NOT NULL,
  original_add_payload TEXT NOT NULL,
  PRIMARY KEY(dataset_id, entry_id)
);
-- Guards run inside the same transaction as inserts, including competing batches.
CREATE TRIGGER operation_guards BEFORE INSERT ON operations BEGIN
  SELECT RAISE(ABORT, 'op_conflict') WHERE EXISTS (
    SELECT 1 FROM operations WHERE dataset_id = NEW.dataset_id
      AND op_id = NEW.op_id AND payload != NEW.payload
  );
  SELECT RAISE(ABORT, 'entry_conflict') WHERE NEW.entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM entry_ids WHERE dataset_id = NEW.dataset_id
      AND entry_id = NEW.entry_id AND original_add_payload != NEW.entry_payload
  );
  SELECT RAISE(ABORT, 'dataset_full') WHERE
    (SELECT operation_count FROM datasets WHERE id = NEW.dataset_id) >= 10000
    AND NOT EXISTS (SELECT 1 FROM operations WHERE dataset_id = NEW.dataset_id AND op_id = NEW.op_id);
END;
CREATE TRIGGER operation_committed AFTER INSERT ON operations BEGIN
  INSERT INTO entry_ids(dataset_id, entry_id, original_add_payload)
    SELECT NEW.dataset_id, NEW.entry_id, NEW.entry_payload WHERE NEW.entry_id IS NOT NULL
    ON CONFLICT(dataset_id, entry_id) DO NOTHING;
  UPDATE datasets SET operation_count = operation_count + 1 WHERE id = NEW.dataset_id;
END;
CREATE TABLE sync_rate_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);

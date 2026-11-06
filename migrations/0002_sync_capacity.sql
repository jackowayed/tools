-- Preserve history, counters, and retry/conflict guards while increasing capacity.
ALTER TABLE datasets ADD COLUMN operation_limit INTEGER NOT NULL DEFAULT 50000;
DROP TRIGGER operation_guards;
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
    (SELECT operation_count FROM datasets WHERE id = NEW.dataset_id) >= (SELECT operation_limit FROM datasets WHERE id = NEW.dataset_id)
    AND NOT EXISTS (SELECT 1 FROM operations WHERE dataset_id = NEW.dataset_id AND op_id = NEW.op_id);
END;

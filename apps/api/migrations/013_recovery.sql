CREATE TABLE recovery_state (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  blocked boolean NOT NULL DEFAULT FALSE,
  backup_id uuid,
  restored_at timestamptz,
  CHECK ((backup_id IS NULL) = (restored_at IS NULL))
);

INSERT INTO recovery_state (singleton) VALUES (TRUE);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_item_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_item_type_check
  CHECK (item_type IN ('file', 'folder', 'share', 'policy', 'employee', 'recovery'));

CREATE TABLE audit_reviewers (
  employee_id uuid PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  identity_issuer text,
  actor_id uuid,
  actor_name text,
  item_type text NOT NULL CHECK (item_type IN ('file', 'folder', 'share')),
  item_id uuid CHECK (item_type <> 'share' OR item_id IS NULL),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 50),
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
  status integer NOT NULL CHECK (status BETWEEN 200 AND 599),
  revision integer CHECK (revision > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (actor_id IS NOT NULL OR actor_name IS NULL)
);

CREATE INDEX audit_events_issuer_recent
  ON audit_events (identity_issuer, occurred_at DESC, id DESC);
CREATE INDEX audit_events_issuer_item_recent
  ON audit_events (identity_issuer, item_id, occurred_at DESC, id DESC)
  WHERE item_id IS NOT NULL;

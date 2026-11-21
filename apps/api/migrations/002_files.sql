CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES employees(id),
  original_name text NOT NULL CHECK (original_name <> ''),
  blob_key uuid NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_owner_created_idx
  ON files (owner_id, created_at DESC, id DESC);

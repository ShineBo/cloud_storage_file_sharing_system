ALTER TABLE files ADD COLUMN mime_type text NOT NULL DEFAULT 'image/png';
ALTER TABLE files ALTER COLUMN mime_type DROP DEFAULT;
ALTER TABLE files ADD CONSTRAINT files_approved_mime_type CHECK (mime_type IN (
  'image/png',
  'image/jpeg',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
));

CREATE TABLE file_upload_reservations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX file_upload_reservations_owner_expiry_idx
  ON file_upload_reservations (owner_id, expires_at);

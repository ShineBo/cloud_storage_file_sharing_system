CREATE TABLE file_revisions (
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  author_id uuid NOT NULL REFERENCES employees (id),
  revised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  blob_key uuid NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN (
    'image/png',
    'image/jpeg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )),
  PRIMARY KEY (file_id, revision)
);

INSERT INTO file_revisions (
  file_id, revision, author_id, revised_at, blob_key, size_bytes, sha256, mime_type
)
SELECT id, 1, owner_id, created_at, blob_key, size_bytes, sha256, mime_type
FROM files;

ALTER TABLE files
  ADD COLUMN current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  ADD CONSTRAINT files_current_revision_fk
    FOREIGN KEY (id, current_revision) REFERENCES file_revisions (file_id, revision)
    DEFERRABLE INITIALLY DEFERRED,
  DROP COLUMN blob_key,
  DROP COLUMN size_bytes,
  DROP COLUMN sha256,
  DROP COLUMN mime_type;

CREATE VIEW current_files AS
SELECT file.id, file.owner_id, file.original_name, file.folder_id, file.created_at,
       revision.revision, revision.author_id, author.display_name AS author_name,
       revision.revised_at, revision.blob_key, revision.size_bytes, revision.sha256, revision.mime_type
FROM files AS file
JOIN file_revisions AS revision ON revision.file_id = file.id AND revision.revision = file.current_revision
JOIN employees AS author ON author.id = revision.author_id;

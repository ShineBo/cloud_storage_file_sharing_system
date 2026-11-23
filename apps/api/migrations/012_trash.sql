CREATE TABLE trash_entries (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES employees (id),
  item_type text NOT NULL CHECK (item_type IN ('file', 'folder')),
  item_id uuid NOT NULL,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  deleted_at timestamptz NOT NULL,
  restore_until timestamptz NOT NULL CHECK (restore_until > deleted_at),
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, item_type, item_id)
);

CREATE INDEX trash_entries_owner_date_idx ON trash_entries (owner_id, deleted_at DESC, id);

ALTER TABLE folders
  ADD COLUMN trash_id uuid,
  ADD CONSTRAINT folders_trash_owner_fk
    FOREIGN KEY (owner_id, trash_id) REFERENCES trash_entries (owner_id, id),
  DROP CONSTRAINT folders_sibling_name_unique;

CREATE UNIQUE INDEX folders_sibling_name_unique ON folders (owner_id, parent_id, name)
  NULLS NOT DISTINCT WHERE trash_id IS NULL;
CREATE INDEX folders_owner_trash_idx ON folders (owner_id, trash_id) WHERE trash_id IS NOT NULL;

ALTER TABLE files
  ADD COLUMN trash_id uuid,
  ADD CONSTRAINT files_trash_owner_fk
    FOREIGN KEY (owner_id, trash_id) REFERENCES trash_entries (owner_id, id);
CREATE INDEX files_owner_trash_idx ON files (owner_id, trash_id) WHERE trash_id IS NOT NULL;

CREATE OR REPLACE VIEW current_files AS
SELECT file.id, file.owner_id, file.original_name, file.folder_id, file.created_at,
       revision.revision, revision.author_id, author.display_name AS author_name,
       revision.revised_at, revision.blob_key, revision.size_bytes, revision.sha256, revision.mime_type
FROM files AS file
JOIN file_revisions AS revision ON revision.file_id = file.id AND revision.revision = file.current_revision
JOIN employees AS author ON author.id = revision.author_id
WHERE file.trash_id IS NULL;

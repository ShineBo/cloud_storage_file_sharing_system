CREATE TABLE folders (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES employees (id),
  parent_id uuid,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folders_owner_id_unique UNIQUE (owner_id, id),
  CONSTRAINT folders_parent_owner_fk
    FOREIGN KEY (owner_id, parent_id) REFERENCES folders (owner_id, id),
  CONSTRAINT folders_parent_not_self CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT folders_sibling_name_unique
    UNIQUE NULLS NOT DISTINCT (owner_id, parent_id, name)
);

ALTER TABLE files
  ADD COLUMN folder_id uuid DEFAULT NULL,
  ADD CONSTRAINT files_folder_owner_fk
    FOREIGN KEY (owner_id, folder_id) REFERENCES folders (owner_id, id);

CREATE INDEX files_owner_folder_created_idx
  ON files (owner_id, folder_id, created_at DESC, id DESC);

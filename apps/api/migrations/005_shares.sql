ALTER TABLE employees ADD CONSTRAINT employees_issuer_id_unique UNIQUE (issuer, id);
ALTER TABLE files ADD CONSTRAINT files_owner_id_unique UNIQUE (owner_id, id);

CREATE TABLE internal_groups (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  name text NOT NULL CHECK (name <> ''),
  approved boolean NOT NULL DEFAULT false,
  UNIQUE (issuer, id),
  UNIQUE (issuer, name)
);

CREATE TABLE internal_group_members (
  issuer text NOT NULL,
  group_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  PRIMARY KEY (group_id, employee_id),
  FOREIGN KEY (issuer, group_id) REFERENCES internal_groups (issuer, id) ON DELETE CASCADE,
  FOREIGN KEY (issuer, employee_id) REFERENCES employees (issuer, id) ON DELETE CASCADE
);

CREATE TABLE shares (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  owner_id uuid NOT NULL,
  request_id uuid NOT NULL,
  file_id uuid,
  folder_id uuid,
  recipient_employee_id uuid,
  recipient_group_id uuid,
  permission text NOT NULL CHECK (permission IN ('view', 'edit')),
  allow_download boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz CHECK (revoked_at >= created_at),
  UNIQUE (owner_id, request_id),
  CHECK (num_nonnulls(file_id, folder_id) = 1),
  CHECK (num_nonnulls(recipient_employee_id, recipient_group_id) = 1),
  FOREIGN KEY (issuer, owner_id) REFERENCES employees (issuer, id),
  FOREIGN KEY (issuer, recipient_employee_id) REFERENCES employees (issuer, id),
  FOREIGN KEY (issuer, recipient_group_id) REFERENCES internal_groups (issuer, id),
  FOREIGN KEY (owner_id, file_id) REFERENCES files (owner_id, id),
  FOREIGN KEY (owner_id, folder_id) REFERENCES folders (owner_id, id)
);

CREATE INDEX shares_owner_file_idx ON shares (owner_id, file_id, created_at DESC)
  WHERE file_id IS NOT NULL;
CREATE INDEX shares_owner_folder_idx ON shares (owner_id, folder_id, created_at DESC)
  WHERE folder_id IS NOT NULL;

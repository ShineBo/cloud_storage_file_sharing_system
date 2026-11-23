CREATE TABLE service_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  allowed_mime_types text[] NOT NULL CHECK (
    cardinality(allowed_mime_types) BETWEEN 1 AND 6
    AND array_position(allowed_mime_types, NULL) IS NULL
    AND allowed_mime_types <@ ARRAY[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg',
      'image/png'
    ]
  ),
  quota_bytes bigint CHECK (quota_bytes BETWEEN 1 AND 20000000000),
  link_expiry_days integer NOT NULL DEFAULT 30 CHECK (link_expiry_days BETWEEN 1 AND 365),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

INSERT INTO service_policy (allowed_mime_types) VALUES (ARRAY[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png'
]);

CREATE TABLE policy_admins (
  employee_id uuid PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE
);

ALTER TABLE employees ADD COLUMN directory_eligible boolean NOT NULL DEFAULT true;
UPDATE employees SET directory_eligible = false WHERE NOT active;
ALTER TABLE employees ADD CONSTRAINT employees_active_requires_directory CHECK (directory_eligible OR NOT active);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_item_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_item_type_check CHECK (item_type IN ('file', 'folder', 'share', 'policy', 'employee')),
  ADD COLUMN detail jsonb CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object');

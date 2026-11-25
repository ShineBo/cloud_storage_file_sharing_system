CREATE INDEX shares_owner_directory_idx ON shares (owner_id, created_at DESC, id DESC);

CREATE INDEX shares_employee_directory_idx ON shares (recipient_employee_id, created_at DESC, id DESC)
  WHERE recipient_employee_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX shares_group_directory_idx ON shares (recipient_group_id, created_at DESC, id DESC)
  WHERE recipient_group_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX internal_group_members_employee_idx ON internal_group_members (employee_id, group_id);

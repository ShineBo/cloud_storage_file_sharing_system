CREATE TABLE employees (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (issuer, subject)
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (issuer, subject) REFERENCES employees (issuer, subject) ON DELETE CASCADE
);

CREATE INDEX auth_sessions_identity_idx ON auth_sessions (issuer, subject);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE oidc_login_attempts (
  token_hash text PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX oidc_login_attempts_expiry_idx ON oidc_login_attempts (expires_at);

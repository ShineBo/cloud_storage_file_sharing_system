ALTER TABLE employees ADD COLUMN notification_email text;

CREATE TABLE share_delivery_requests (
  share_id uuid PRIMARY KEY REFERENCES shares (id) ON DELETE CASCADE
);

CREATE TABLE share_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES share_delivery_requests (share_id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_id uuid,
  claim_until timestamptz,
  UNIQUE (share_id, recipient_id),
  CHECK ((status = 'sending') = (claim_id IS NOT NULL AND claim_until IS NOT NULL))
);

CREATE INDEX share_deliveries_queue_idx ON share_deliveries (queued_at, id)
  WHERE status IN ('pending', 'sending');

CREATE TABLE share_delivery_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES share_deliveries (id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  failure_code text,
  CHECK ((status = 'sending') = (finished_at IS NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX share_delivery_attempts_delivery_idx ON share_delivery_attempts (delivery_id, started_at DESC);

CREATE VIEW share_delivery_status AS
SELECT request.share_id,
       CASE
         WHEN bool_or(delivery.status IN ('pending', 'sending')) THEN 'pending'
         WHEN count(delivery.id) = 0 THEN 'failed'
         WHEN count(*) FILTER (WHERE delivery.status = 'sent') = count(delivery.id) THEN 'sent'
         WHEN bool_or(delivery.status = 'sent') THEN 'partial'
         ELSE 'failed'
       END AS status,
       (count(*) FILTER (WHERE delivery.status = 'sent'))::integer AS sent,
       count(delivery.id)::integer AS total
FROM share_delivery_requests AS request
LEFT JOIN share_deliveries AS delivery USING (share_id)
GROUP BY request.share_id;

CREATE TABLE security_alerts (
  audit_event_id uuid PRIMARY KEY REFERENCES audit_events (id) ON DELETE CASCADE,
  rule text NOT NULL CHECK (rule ~ '^[a-z0-9-]{1,50}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  claim_id uuid,
  claim_until timestamptz,
  CHECK ((status = 'sending') = (claim_id IS NOT NULL AND claim_until IS NOT NULL))
);

CREATE INDEX security_alerts_queue_idx ON security_alerts (next_attempt_at, audit_event_id)
  WHERE status IN ('pending', 'sending');

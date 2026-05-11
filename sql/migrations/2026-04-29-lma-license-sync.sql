ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS subscriber_email TEXT;

ALTER TABLE license_events
    ADD COLUMN IF NOT EXISTS org_id TEXT;

ALTER TABLE license_events
    ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE license_events
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

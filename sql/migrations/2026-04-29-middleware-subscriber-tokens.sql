ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS middleware_token TEXT;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS middleware_token_hash TEXT;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS middleware_token_issued_at TIMESTAMPTZ;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS middleware_token_revoked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscribers_middleware_token_hash
    ON subscribers (middleware_token_hash)
    WHERE middleware_token_hash IS NOT NULL;

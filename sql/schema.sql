CREATE TABLE IF NOT EXISTS subscribers (
    id BIGSERIAL PRIMARY KEY,
    org_id TEXT NOT NULL UNIQUE,
    installation_id TEXT,
    account_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_entitlements (
    id BIGSERIAL PRIMARY KEY,
    subscriber_id BIGINT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    product_name TEXT NOT NULL,
    edition TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    trial_start_date DATE,
    trial_end_date DATE,
    middleware_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    enterprise_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (subscriber_id, product_name)
);

CREATE INDEX IF NOT EXISTS idx_product_entitlements_subscriber_id
    ON product_entitlements (subscriber_id);

CREATE TABLE IF NOT EXISTS license_events (
    id BIGSERIAL PRIMARY KEY,
    subscriber_id BIGINT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    product_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    previous_edition TEXT,
    next_edition TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

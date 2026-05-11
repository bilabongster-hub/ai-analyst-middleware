DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM subscribers
        GROUP BY org_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Migration blocked: duplicate subscribers.org_id rows exist. Run the duplicate detection query and complete manual cleanup before re-running this migration.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM product_entitlements
        GROUP BY subscriber_id, product_name
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Migration blocked: duplicate product_entitlements rows exist for the same subscriber_id + product_name. Run the duplicate detection query and complete manual cleanup before re-running this migration.';
    END IF;
END $$;

ALTER TABLE subscribers
    ALTER COLUMN org_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscribers_org_id
    ON subscribers (org_id);

ALTER TABLE product_entitlements
    ADD COLUMN IF NOT EXISTS edition TEXT,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS middleware_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS enterprise_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
    metadata_udt_name TEXT;
BEGIN
    SELECT c.udt_name
    INTO metadata_udt_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'product_entitlements'
      AND c.column_name = 'metadata';

    IF metadata_udt_name IS NULL THEN
        EXECUTE $ddl$
            ALTER TABLE product_entitlements
            ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        $ddl$;
    ELSIF metadata_udt_name = 'jsonb' THEN
        NULL;
    ELSIF metadata_udt_name = 'json' THEN
        EXECUTE $ddl$
            ALTER TABLE product_entitlements
            ALTER COLUMN metadata TYPE JSONB
            USING metadata::jsonb
        $ddl$;
    ELSE
        RAISE EXCEPTION
            'Migration blocked: product_entitlements.metadata has unsupported type "%". Convert it to valid JSONB manually before re-running this migration.',
            metadata_udt_name;
    END IF;
END $$;

ALTER TABLE product_entitlements
    ALTER COLUMN edition SET NOT NULL,
    ALTER COLUMN is_active SET NOT NULL,
    ALTER COLUMN middleware_enabled SET NOT NULL,
    ALTER COLUMN enterprise_enabled SET NOT NULL,
    ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_entitlements_subscriber_product
    ON product_entitlements (subscriber_id, product_name);

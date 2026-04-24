import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pool;

function buildSslConfig() {
    const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
    const shouldUseSsl = sslMode === 'require' || process.env.DATABASE_REQUIRE_SSL === 'true';
    return shouldUseSsl ? { rejectUnauthorized: false } : false;
}

export function isDatabaseConfigured() {
    return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
    if (!isDatabaseConfigured()) {
        return null;
    }

    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: buildSslConfig()
        });
    }

    return pool;
}

export async function checkDatabaseHealth() {
    if (!isDatabaseConfigured()) {
        return {
            configured: false,
            healthy: false
        };
    }

    try {
        await getPool().query('SELECT 1');
        return {
            configured: true,
            healthy: true
        };
    } catch (error) {
        return {
            configured: true,
            healthy: false,
            error: error.message
        };
    }
}

export async function initializeDatabase() {
    if (!isDatabaseConfigured()) {
        throw new Error('DATABASE_URL is required to initialize the licensing database.');
    }

    const schemaPath = path.join(__dirname, 'sql', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await getPool().query(schemaSql);
}

export async function findSubscriberByOrgId(orgId) {
    if (!isDatabaseConfigured() || !orgId) {
        return null;
    }

    const result = await getPool().query(
        `
        SELECT id, org_id, installation_id, account_name, status
        FROM subscribers
        WHERE org_id = $1
        LIMIT 1
        `,
        [orgId]
    );

    return result.rows[0] || null;
}

export async function findSubscriberByMiddlewareToken(middlewareToken) {
    if (!isDatabaseConfigured() || !middlewareToken) {
        return null;
    }

    const result = await getPool().query(
        `
        SELECT id, org_id, installation_id, account_name, status, middleware_token
        FROM subscribers
        WHERE middleware_token = $1
        LIMIT 1
        `,
        [middlewareToken]
    );

    return result.rows[0] || null;
}

export async function getEntitlementsForSubscriber(subscriberId) {
    if (!isDatabaseConfigured() || !subscriberId) {
        return [];
    }

    const result = await getPool().query(
        `
        SELECT
            product_name,
            edition,
            is_active,
            trial_start_date,
            trial_end_date,
            middleware_enabled,
            enterprise_enabled,
            metadata
        FROM product_entitlements
        WHERE subscriber_id = $1
        ORDER BY product_name
        `,
        [subscriberId]
    );

    return result.rows;
}

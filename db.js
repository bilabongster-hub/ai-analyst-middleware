import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import pkg from 'pg';
import { assertKnownProductName, getKnownProductNames } from './productCatalog.js';

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pool;
const SUBSCRIBER_BASE_COLUMNS = 'id, org_id, installation_id, account_name, status';

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
        SELECT ${SUBSCRIBER_BASE_COLUMNS}
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

    const poolRef = getPool();
    const client = await poolRef.connect();
    try {
        const schema = await resolveSchema(client);
        const conditions = [];
        const values = [];

        if (schema.subscribers.has('middleware_token_hash')) {
            values.push(hashMiddlewareToken(middlewareToken));
            const revokedPredicate = schema.subscribers.has('middleware_token_revoked_at')
                ? ' AND middleware_token_revoked_at IS NULL'
                : '';
            conditions.push(`(middleware_token_hash = $${values.length}${revokedPredicate})`);
        }

        if (schema.subscribers.has('middleware_token')) {
            values.push(middlewareToken);
            conditions.push(`(middleware_token = $${values.length})`);
        }

        if (conditions.length === 0) {
            return null;
        }

        const result = await client.query(
            `
            SELECT ${SUBSCRIBER_BASE_COLUMNS}
            FROM subscribers
            WHERE ${conditions.join(' OR ')}
            LIMIT 1
            `,
            values
        );

        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

export async function getEntitlementsForSubscriber(subscriberId) {
    if (!isDatabaseConfigured() || !subscriberId) {
        return [];
    }

    const knownProductNames = getKnownProductNames();
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
          AND product_name = ANY($2)
        ORDER BY product_name
        `,
        [subscriberId, knownProductNames]
    );

    return result.rows;
}

function normalizeOrgId(orgId) {
    return typeof orgId === 'string' ? orgId.trim() : '';
}

function normalizePackageName(packageName) {
    return typeof packageName === 'string' ? packageName.trim() : '';
}

function normalizeLicenseStatus(licenseStatus) {
    return typeof licenseStatus === 'string' ? licenseStatus.trim().toLowerCase() : '';
}

function toIsoString(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toSqlDate(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString().slice(0, 10);
}

function normalizeEditionForSalesforce(edition) {
    const normalizedEdition = typeof edition === 'string' ? edition.trim().toLowerCase() : '';
    if (normalizedEdition === 'trial') {
        return 'FreeTrial';
    }
    if (normalizedEdition === 'paid') {
        return 'Paid';
    }
    if (normalizedEdition === 'enterprise') {
        return 'Enterprise';
    }
    return edition;
}

function cleanObject(objectValue) {
    const cleaned = {};
    for (const [key, value] of Object.entries(objectValue || {})) {
        if (value !== undefined) {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

function hashMiddlewareToken(tokenValue) {
    return createHash('sha256').update(tokenValue, 'utf8').digest('hex');
}

function generateMiddlewareTokenValue() {
    return randomBytes(32).toString('hex');
}

async function getTableColumns(client, tableName) {
    const result = await client.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        `,
        [tableName]
    );

    return new Set(result.rows.map((row) => row.column_name));
}

async function resolveSchema(client, providedSchema) {
    if (providedSchema) {
        return {
            subscribers: providedSchema.subscribers || new Set(),
            product_entitlements: providedSchema.product_entitlements || new Set(),
            license_events: providedSchema.license_events || new Set()
        };
    }

    return {
        subscribers: await getTableColumns(client, 'subscribers'),
        product_entitlements: await getTableColumns(client, 'product_entitlements'),
        license_events: await getTableColumns(client, 'license_events')
    };
}

function buildSubscriberStatement(syncRequest, subscriberColumns, orgId, normalizedLicenseStatus) {
    const columns = ['org_id'];
    const values = [orgId];
    const placeholders = ['$1'];
    const updates = [];

    if (subscriberColumns.has('status')) {
        columns.push('status');
        values.push(normalizedLicenseStatus || 'active');
        placeholders.push(`$${values.length}`);
        updates.push('status = EXCLUDED.status');
    }

    if (subscriberColumns.has('account_name')) {
        columns.push('account_name');
        values.push(syncRequest.subscriberName || null);
        placeholders.push(`$${values.length}`);
        updates.push('account_name = EXCLUDED.account_name');
    }

    if (subscriberColumns.has('subscriber_email')) {
        columns.push('subscriber_email');
        values.push(syncRequest.subscriberEmail || null);
        placeholders.push(`$${values.length}`);
        updates.push('subscriber_email = EXCLUDED.subscriber_email');
    }

    if (subscriberColumns.has('updated_at')) {
        columns.push('updated_at');
        values.push(new Date());
        placeholders.push(`$${values.length}`);
        updates.push('updated_at = EXCLUDED.updated_at');
    }

    return {
        sql: `
            INSERT INTO subscribers (${columns.join(', ')})
            VALUES (${placeholders.join(', ')})
            ON CONFLICT (org_id)
            DO UPDATE SET ${updates.length > 0 ? updates.join(', ') : 'org_id = EXCLUDED.org_id'}
            RETURNING *
        `,
        values
    };
}

function mapLmaStatusToEntitlement(syncRequest, previousEntitlement, currentTimestamp) {
    const normalizedLicenseStatus = normalizeLicenseStatus(syncRequest.licenseStatus);
    const previousEdition = typeof previousEntitlement?.edition === 'string'
        ? previousEntitlement.edition.trim().toLowerCase()
        : '';
    const preserveEnterpriseEdition =
        previousEdition === 'enterprise' && syncRequest.forceDowngrade !== true;

    if (preserveEnterpriseEdition) {
        return {
            edition: previousEntitlement.edition,
            isActive: previousEntitlement.is_active !== false,
            trialStartDate: previousEntitlement.trial_start_date || null,
            trialEndDate: previousEntitlement.trial_end_date || null,
            enterpriseEnabled: true
        };
    }

    if (normalizedLicenseStatus === 'trial') {
        return {
            edition: 'trial',
            isActive: true,
            trialStartDate: previousEntitlement?.trial_start_date || toSqlDate(currentTimestamp),
            trialEndDate: toSqlDate(syncRequest.expirationDate),
            enterpriseEnabled: previousEntitlement?.enterprise_enabled === true
        };
    }

    if (normalizedLicenseStatus === 'active') {
        return {
            edition: 'paid',
            isActive: true,
            trialStartDate: null,
            trialEndDate: null,
            enterpriseEnabled: previousEntitlement?.enterprise_enabled === true
        };
    }

    if (['suspended', 'expired', 'uninstalled'].includes(normalizedLicenseStatus)) {
        return {
            edition: previousEdition || 'paid',
            isActive: false,
            trialStartDate: previousEntitlement?.trial_start_date || null,
            trialEndDate: previousEntitlement?.trial_end_date || toSqlDate(syncRequest.expirationDate),
            enterpriseEnabled: previousEntitlement?.enterprise_enabled === true
        };
    }

    throw new Error(`Unsupported licenseStatus: ${syncRequest.licenseStatus}`);
}

async function insertLicenseEventIfSupported(client, licenseEventColumns, eventPayload) {
    if (!licenseEventColumns || licenseEventColumns.size === 0) {
        return;
    }

    const columns = [];
    const placeholders = [];
    const values = [];

    const addValue = (columnName, value, cast = '') => {
        if (!licenseEventColumns.has(columnName)) {
            return;
        }
        columns.push(columnName);
        values.push(value);
        placeholders.push(`$${values.length}${cast}`);
    };

    addValue('subscriber_id', eventPayload.subscriberId);
    addValue('product_name', eventPayload.productName);
    addValue('event_type', 'LMA_LICENSE_SYNC');
    addValue('previous_edition', eventPayload.previousEdition);
    addValue('next_edition', eventPayload.nextEdition);
    addValue('notes', eventPayload.notes);
    addValue('source', 'LMA');
    addValue('org_id', eventPayload.orgId);
    addValue('metadata', JSON.stringify(eventPayload.metadata), '::jsonb');

    if (columns.length === 0) {
        return;
    }

    await client.query(
        `
        INSERT INTO license_events (${columns.join(', ')})
        VALUES (${placeholders.join(', ')})
        `,
        values
    );
}

export async function issueSubscriberMiddlewareToken(subscriberId, options = {}) {
    if ((!options.pool && !isDatabaseConfigured()) || !subscriberId) {
        return null;
    }

    const poolRef = options.pool || getPool();
    const client = await poolRef.connect();
    const issuedAt = options.currentTimestamp || new Date();
    const plainToken = generateMiddlewareTokenValue();
    const tokenHash = hashMiddlewareToken(plainToken);

    try {
        const schema = await resolveSchema(client, options.schema);
        const updates = [];
        const values = [];

        const pushUpdate = (clause, value) => {
            values.push(value);
            updates.push(`${clause} = $${values.length}`);
        };

        if (schema.subscribers.has('middleware_token_hash')) {
            pushUpdate('middleware_token_hash', tokenHash);
        }

        if (schema.subscribers.has('middleware_token')) {
            pushUpdate(
                'middleware_token',
                schema.subscribers.has('middleware_token_hash') ? null : plainToken
            );
        }

        if (schema.subscribers.has('middleware_token_issued_at')) {
            pushUpdate('middleware_token_issued_at', issuedAt);
        }

        if (schema.subscribers.has('middleware_token_revoked_at')) {
            pushUpdate('middleware_token_revoked_at', null);
        }

        if (schema.subscribers.has('updated_at')) {
            pushUpdate('updated_at', issuedAt);
        }

        if (updates.length === 0) {
            throw new Error('Subscriber token storage columns are not available.');
        }

        values.push(subscriberId);
        await client.query(
            `
            UPDATE subscribers
            SET ${updates.join(', ')}
            WHERE id = $${values.length}
            `,
            values
        );

        return plainToken;
    } finally {
        client.release();
    }
}

export async function revokeSubscriberMiddlewareToken(subscriberId, options = {}) {
    if ((!options.pool && !isDatabaseConfigured()) || !subscriberId) {
        return false;
    }

    const poolRef = options.pool || getPool();
    const client = await poolRef.connect();
    const revokedAt = options.currentTimestamp || new Date();

    try {
        const schema = await resolveSchema(client, options.schema);
        const updates = [];
        const values = [];

        const pushUpdate = (clause, value) => {
            values.push(value);
            updates.push(`${clause} = $${values.length}`);
        };

        if (schema.subscribers.has('middleware_token_hash')) {
            pushUpdate('middleware_token_hash', null);
        }
        if (schema.subscribers.has('middleware_token')) {
            pushUpdate('middleware_token', null);
        }
        if (schema.subscribers.has('middleware_token_revoked_at')) {
            pushUpdate('middleware_token_revoked_at', revokedAt);
        }
        if (schema.subscribers.has('updated_at')) {
            pushUpdate('updated_at', revokedAt);
        }

        if (updates.length === 0) {
            return false;
        }

        values.push(subscriberId);
        await client.query(
            `
            UPDATE subscribers
            SET ${updates.join(', ')}
            WHERE id = $${values.length}
            `,
            values
        );

        return true;
    } finally {
        client.release();
    }
}

export async function applyLmaLicenseSync(syncRequest, options = {}) {
    if (!options.pool && !isDatabaseConfigured()) {
        throw new Error('DATABASE_URL is required for LMA license sync.');
    }

    const orgId = normalizeOrgId(syncRequest?.orgId);
    const packageName = normalizePackageName(syncRequest?.packageName);
    const normalizedLicenseStatus = normalizeLicenseStatus(syncRequest?.licenseStatus);
    if (!orgId) {
        throw new Error('orgId is required');
    }
    if (!packageName) {
        throw new Error('packageName is required');
    }
    if (!normalizedLicenseStatus) {
        throw new Error('licenseStatus is required');
    }

    const currentTimestamp = options.currentTimestamp || new Date();
    const source = (syncRequest.source || 'LMA').trim();
    const poolRef = options.pool || getPool();
    const client = await poolRef.connect();

    try {
        await client.query('BEGIN');
        const schema = await resolveSchema(client, options.schema);
        const knownProductNames = getKnownProductNames();

        const subscriberStatement = buildSubscriberStatement(
            syncRequest,
            schema.subscribers,
            orgId,
            normalizedLicenseStatus
        );
        const subscriberResult = await client.query(subscriberStatement.sql, subscriberStatement.values);

        const subscriber = subscriberResult.rows[0];
        const existingEntitlements = await client.query(
            `
            SELECT product_name, edition, is_active, enterprise_enabled, middleware_enabled, metadata,
                   trial_start_date, trial_end_date
            FROM product_entitlements
            WHERE subscriber_id = $1
              AND product_name = ANY($2)
            `,
            [subscriber.id, knownProductNames]
        );
        const existingByProduct = new Map(
            existingEntitlements.rows.map((row) => [row.product_name, row])
        );

        let createdCount = 0;
        let updatedCount = 0;
        let deletedCount = 0;
        let preservedEnterpriseCount = 0;

        for (const productName of knownProductNames) {
            assertKnownProductName(productName, 'product entitlement');
            const previous = existingByProduct.get(productName);
            const nextEntitlement = mapLmaStatusToEntitlement(syncRequest, previous, currentTimestamp);
            const existingMetadata = previous?.metadata && typeof previous.metadata === 'object'
                ? previous.metadata
                : {};
            const eventMetadata = cleanObject({
                packageName,
                lmaLicenseId: syncRequest.lmaLicenseId,
                lmaPackageVersionId: syncRequest.lmaPackageVersionId,
                seats: syncRequest.seats,
                expirationDate: syncRequest.expirationDate || null,
                licenseStatus: syncRequest.licenseStatus,
                source: 'LMA',
                lastLmaSyncedAt: toIsoString(currentTimestamp)
            });
            const mergedMetadata = {
                ...existingMetadata,
                ...eventMetadata
            };

            if ((previous?.edition || '').trim().toLowerCase() === 'enterprise' && syncRequest.forceDowngrade !== true) {
                preservedEnterpriseCount++;
            }

            await client.query(
                `
                INSERT INTO product_entitlements (
                    subscriber_id,
                    product_name,
                    edition,
                    is_active,
                    trial_start_date,
                    trial_end_date,
                    middleware_enabled,
                    enterprise_enabled,
                    metadata,
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
                ON CONFLICT (subscriber_id, product_name)
                DO UPDATE SET
                    edition = EXCLUDED.edition,
                    is_active = EXCLUDED.is_active,
                    trial_start_date = EXCLUDED.trial_start_date,
                    trial_end_date = EXCLUDED.trial_end_date,
                    middleware_enabled = EXCLUDED.middleware_enabled,
                    enterprise_enabled = EXCLUDED.enterprise_enabled,
                    metadata = EXCLUDED.metadata,
                    updated_at = NOW()
                `,
                [
                    subscriber.id,
                    productName,
                    nextEntitlement.edition,
                    nextEntitlement.isActive,
                    nextEntitlement.trialStartDate,
                    nextEntitlement.trialEndDate,
                    previous?.middleware_enabled === true,
                    nextEntitlement.enterpriseEnabled === true,
                    JSON.stringify(mergedMetadata)
                ]
            );

            if (!previous) {
                createdCount++;
                await insertLicenseEventIfSupported(client, schema.license_events, {
                    subscriberId: subscriber.id,
                    productName,
                    previousEdition: null,
                    nextEdition: nextEntitlement.edition,
                    orgId,
                    notes: JSON.stringify(eventMetadata),
                    metadata: eventMetadata
                });
                continue;
            }

            if (
                previous.edition !== nextEntitlement.edition ||
                previous.is_active !== nextEntitlement.isActive ||
                previous.enterprise_enabled !== nextEntitlement.enterpriseEnabled
            ) {
                updatedCount++;
                await insertLicenseEventIfSupported(client, schema.license_events, {
                    subscriberId: subscriber.id,
                    productName,
                    previousEdition: previous.edition,
                    nextEdition: nextEntitlement.edition,
                    orgId,
                    notes: JSON.stringify(eventMetadata),
                    metadata: eventMetadata
                });
            }
        }

        await client.query('COMMIT');

        return {
            subscriber,
            createdCount,
            updatedCount,
            deletedCount,
            preservedEnterpriseCount,
            entitlementCount: knownProductNames.length,
            packageName,
            licenseStatus: syncRequest.licenseStatus,
            source
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

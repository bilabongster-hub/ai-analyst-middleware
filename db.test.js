import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLmaLicenseSync, issueSubscriberMiddlewareToken } from './db.js';
import { PRODUCT_NAMES, PRODUCT_CODES } from './productCatalog.js';

function createFakePool() {
    const state = {
        subscriber: null,
        nextSubscriberId: 1,
        entitlements: new Map(),
        events: []
    };

    const client = {
        async query(sql, values = []) {
            const normalizedSql = sql.replace(/\s+/g, ' ').trim();

            if (
                normalizedSql === 'BEGIN' ||
                normalizedSql === 'COMMIT' ||
                normalizedSql === 'ROLLBACK'
            ) {
                return { rows: [] };
            }

            if (normalizedSql.startsWith('INSERT INTO subscribers')) {
                const columnsMatch = normalizedSql.match(/INSERT INTO subscribers \((.+?)\) VALUES/i);
                const columns = columnsMatch[1].split(',').map((column) => column.trim());
                const row = state.subscriber || { id: state.nextSubscriberId++ };
                columns.forEach((column, index) => {
                    row[column] = values[index];
                });
                state.subscriber = row;
                return { rows: [row] };
            }

            if (normalizedSql.startsWith('SELECT product_name, edition, is_active, enterprise_enabled')) {
                return {
                    rows: [...state.entitlements.values()].map((row) => ({ ...row }))
                };
            }

            if (normalizedSql.startsWith('INSERT INTO product_entitlements')) {
                const row = {
                    subscriber_id: values[0],
                    product_name: values[1],
                    edition: values[2],
                    is_active: values[3],
                    trial_start_date: values[4],
                    trial_end_date: values[5],
                    middleware_enabled: values[6],
                    enterprise_enabled: values[7],
                    metadata: JSON.parse(values[8])
                };
                state.entitlements.set(row.product_name, row);
                return { rows: [] };
            }

            if (normalizedSql.startsWith('INSERT INTO license_events')) {
                const columnsMatch = normalizedSql.match(/INSERT INTO license_events \((.+?)\) VALUES/i);
                const columns = columnsMatch[1].split(',').map((column) => column.trim());
                const event = {};
                columns.forEach((column, index) => {
                    const value = values[index];
                    event[column] = column === 'metadata' && typeof value === 'string'
                        ? JSON.parse(value)
                        : value;
                });
                state.events.push(event);
                return { rows: [] };
            }

            throw new Error(`Unexpected SQL in test fake: ${normalizedSql}`);
        },
        release() {}
    };

    return {
        state,
        connect: async () => client
    };
}

function buildSchema() {
    return {
        subscribers: new Set(['org_id', 'account_name', 'subscriber_email', 'status', 'updated_at']),
        product_entitlements: new Set([
            'subscriber_id',
            'product_name',
            'edition',
            'is_active',
            'trial_start_date',
            'trial_end_date',
            'middleware_enabled',
            'enterprise_enabled',
            'metadata',
            'updated_at'
        ]),
        license_events: new Set([
            'subscriber_id',
            'org_id',
            'product_name',
            'event_type',
            'source',
            'previous_edition',
            'next_edition',
            'notes',
            'metadata'
        ])
    };
}

function buildPayload(overrides = {}) {
    return {
        orgId: ' 00DTESTORG000001 ',
        packageName: 'AI Analyst Suite',
        licenseStatus: 'Trial',
        seats: 10,
        expirationDate: '2026-05-01',
        subscriberName: 'Customer Name',
        subscriberEmail: 'admin@example.com',
        lmaLicenseId: 'a00xxxxxxxxxxxxxxx',
        lmaPackageVersionId: 'a01xxxxxxxxxxxxxxx',
        source: 'LMA',
        ...overrides
    };
}

function createTokenPool() {
    const state = {
        updates: []
    };

    const client = {
        async query(sql, values = []) {
            const normalizedSql = sql.replace(/\s+/g, ' ').trim();
            if (normalizedSql.startsWith('UPDATE subscribers SET')) {
                state.updates.push({ sql: normalizedSql, values: [...values] });
                return { rows: [] };
            }
            throw new Error(`Unexpected SQL in token fake: ${normalizedSql}`);
        },
        release() {}
    };

    return {
        state,
        connect: async () => client
    };
}

test('trial creates two product entitlements', async () => {
    const fakePool = createFakePool();
    const result = await applyLmaLicenseSync(buildPayload(), {
        pool: fakePool,
        schema: buildSchema(),
        currentTimestamp: new Date('2026-04-29T12:00:00.000Z')
    });

    assert.equal(result.createdCount, 2);
    assert.equal(fakePool.state.entitlements.size, 2);
    for (const productName of Object.values(PRODUCT_NAMES)) {
        const entitlement = fakePool.state.entitlements.get(productName);
        assert.equal(entitlement.edition, 'trial');
        assert.equal(entitlement.is_active, true);
        assert.equal(entitlement.metadata.licenseStatus, 'Trial');
        assert.equal(entitlement.metadata.source, 'LMA');
    }
});

test('active upgrades trial to paid', async () => {
    const fakePool = createFakePool();
    await applyLmaLicenseSync(buildPayload(), {
        pool: fakePool,
        schema: buildSchema(),
        currentTimestamp: new Date('2026-04-29T12:00:00.000Z')
    });

    const result = await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Active' }), {
        pool: fakePool,
        schema: buildSchema(),
        currentTimestamp: new Date('2026-04-30T12:00:00.000Z')
    });

    assert.equal(result.updatedCount, 2);
    assert.equal(fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR]).edition, 'paid');
    assert.equal(fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR]).edition, 'paid');
});

test('suspended deactivates entitlement', async () => {
    const fakePool = createFakePool();
    await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Active' }), {
        pool: fakePool,
        schema: buildSchema()
    });

    await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Suspended' }), {
        pool: fakePool,
        schema: buildSchema()
    });

    assert.equal(fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR]).is_active, false);
    assert.equal(fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR]).is_active, false);
});

test('expired deactivates entitlement', async () => {
    const fakePool = createFakePool();
    await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Active' }), {
        pool: fakePool,
        schema: buildSchema()
    });

    await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Expired' }), {
        pool: fakePool,
        schema: buildSchema()
    });

    assert.equal(fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR]).is_active, false);
    assert.equal(fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR]).is_active, false);
});

test('enterprise entitlement is preserved', async () => {
    const fakePool = createFakePool();
    fakePool.state.subscriber = {
        id: 1,
        org_id: '00DTESTORG000001',
        account_name: 'Customer Name',
        subscriber_email: 'admin@example.com',
        status: 'active'
    };
    fakePool.state.entitlements.set(PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR], {
        subscriber_id: 1,
        product_name: PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR],
        edition: 'enterprise',
        is_active: true,
        trial_start_date: null,
        trial_end_date: null,
        middleware_enabled: false,
        enterprise_enabled: true,
        metadata: { existing: true }
    });
    fakePool.state.entitlements.set(PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR], {
        subscriber_id: 1,
        product_name: PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR],
        edition: 'paid',
        is_active: true,
        trial_start_date: null,
        trial_end_date: null,
        middleware_enabled: false,
        enterprise_enabled: false,
        metadata: {}
    });

    const result = await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Active' }), {
        pool: fakePool,
        schema: buildSchema()
    });

    assert.equal(result.preservedEnterpriseCount, 1);
    const preserved = fakePool.state.entitlements.get(PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR]);
    assert.equal(preserved.edition, 'enterprise');
    assert.equal(preserved.enterprise_enabled, true);
});

test('repeated sync does not duplicate rows', async () => {
    const fakePool = createFakePool();
    await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Active' }), {
        pool: fakePool,
        schema: buildSchema()
    });
    await applyLmaLicenseSync(buildPayload({ licenseStatus: 'Active' }), {
        pool: fakePool,
        schema: buildSchema()
    });

    assert.equal(fakePool.state.entitlements.size, 2);
    assert.equal(fakePool.state.subscriber.id, 1);
});

test('bootstrap token issuance stores only the hash when hashed columns exist', async () => {
    const tokenPool = createTokenPool();
    const token = await issueSubscriberMiddlewareToken(7, {
        pool: tokenPool,
        schema: {
            subscribers: new Set([
                'middleware_token',
                'middleware_token_hash',
                'middleware_token_issued_at',
                'middleware_token_revoked_at',
                'updated_at'
            ]),
            product_entitlements: new Set(),
            license_events: new Set()
        },
        currentTimestamp: new Date('2026-04-29T12:00:00.000Z')
    });

    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(tokenPool.state.updates.length, 1);
    const updateValues = tokenPool.state.updates[0].values;
    assert.match(updateValues[0], /^[0-9a-f]{64}$/);
    assert.notEqual(updateValues[0], token);
    assert.equal(updateValues[1], null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.js';
import { PRODUCT_NAMES, PRODUCT_CODES } from './productCatalog.js';

async function withServer(dependencies, callback) {
    const { app } = createApp(dependencies);
    const server = http.createServer(app);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        await callback(baseUrl);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test('subscriber bootstrap returns only middleware token data', async () => {
    let entitlementLookupCount = 0;
    let issuedSubscriberId = null;
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByOrgId: async () => ({
                id: 7,
                org_id: '00DTEST00000001',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            issueSubscriberMiddlewareToken: async (subscriberId) => {
                issuedSubscriberId = subscriberId;
                return 'rotated-token-1';
            },
            getEntitlementsForSubscriber: async () => {
                entitlementLookupCount++;
                return [];
            }
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/subscriber-bootstrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ orgId: '00DTEST00000001', packageName: 'AI Analyst Suite' })
            });

            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.success, true);
            assert.equal(payload.middlewareToken, 'rotated-token-1');
            assert.equal(payload.rotationPolicy, 'rotate_on_bootstrap');
            assert.equal('entitlements' in payload, false);
            assert.equal(entitlementLookupCount, 0);
            assert.equal(issuedSubscriberId, 7);
        }
    );
});

test('subscriber bootstrap returns pending before LMA sync arrives', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByOrgId: async () => null
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/subscriber-bootstrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ orgId: '00DTEST00000001', packageName: 'AI Analyst Suite' })
            });

            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.status, 'LICENSE_PENDING_LMA_SYNC');
            assert.equal(
                payload.message,
                'License setup is still in progress. Please refresh license status in a few minutes.'
            );
            assert.equal(payload.message.includes('trial expired'), false);
        }
    );
});

test('subscriber bootstrap rejects invalid package context', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/subscriber-bootstrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ orgId: '00DTEST00000001', packageName: 'Wrong Package' })
            });

            assert.equal(response.status, 400);
            const payload = await response.json();
            assert.equal(payload.error, 'Unsupported packageName: Wrong Package');
        }
    );
});

test('subscriber bootstrap rejects invalid orgId format', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/subscriber-bootstrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ orgId: 'bad-org-id', packageName: 'AI Analyst Suite' })
            });

            assert.equal(response.status, 400);
            const payload = await response.json();
            assert.equal(payload.error, 'orgId format is invalid');
        }
    );
});

test('repeated bootstrap rotates subscriber token without creating entitlements', async () => {
    const issuedTokens = ['token-a', 'token-b'];
    let issueCallCount = 0;
    let entitlementLookupCount = 0;
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByOrgId: async () => ({
                id: 9,
                org_id: '00DROTATE000001',
                installation_id: 'inst-9',
                account_name: 'Rotate Co',
                status: 'active'
            }),
            issueSubscriberMiddlewareToken: async () => issuedTokens[issueCallCount++],
            getEntitlementsForSubscriber: async () => {
                entitlementLookupCount++;
                return [];
            }
        },
        async (baseUrl) => {
            const request = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ orgId: '00DROTATE000001', packageName: 'AI Analyst Suite' })
            };
            const first = await fetch(`${baseUrl}/api/subscriber-bootstrap`, request);
            const second = await fetch(`${baseUrl}/api/subscriber-bootstrap`, request);

            assert.equal(first.status, 200);
            assert.equal(second.status, 200);
            assert.equal((await first.json()).middlewareToken, 'token-a');
            assert.equal((await second.json()).middlewareToken, 'token-b');
            assert.equal(issueCallCount, 2);
            assert.equal(entitlementLookupCount, 0);
        }
    );
});

test('license sync writes through only the LMA endpoint', async () => {
    let syncCalls = 0;
    await withServer(
        {
            isDatabaseConfigured: () => true,
            lmaSyncSecret: 'lma-secret',
            applyLmaLicenseSync: async (payload) => {
                syncCalls++;
                assert.equal(payload.orgId, '00DTEST');
                assert.equal(payload.packageName, 'AI Analyst Suite');
                assert.equal(payload.licenseStatus, 'Trial');
                return {
                    subscriber: {
                        org_id: '00DTEST',
                        installation_id: 'inst-1',
                        account_name: 'Acme',
                        status: 'active'
                    },
                    entitlementCount: 2,
                    createdCount: 1,
                    updatedCount: 1,
                    deletedCount: 0
                };
            }
        },
        async (baseUrl) => {
            const unauthorized = await fetch(`${baseUrl}/lma/license-sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orgId: '00DTEST' })
            });
            assert.equal(unauthorized.status, 401);

            const authorized = await fetch(`${baseUrl}/lma/license-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-aias-lma-secret': 'lma-secret'
                },
                body: JSON.stringify({
                    orgId: '00DTEST',
                    packageName: 'AI Analyst Suite',
                    licenseStatus: 'Trial',
                    seats: 10,
                    expirationDate: '2026-05-01',
                    subscriberName: 'Acme',
                    subscriberEmail: 'admin@example.com',
                    lmaLicenseId: 'a00xxxxxxxxxxxxxxx',
                    lmaPackageVersionId: 'a01xxxxxxxxxxxxxxx',
                    source: 'LMA'
                })
            });

            assert.equal(authorized.status, 200);
            const payload = await authorized.json();
            assert.equal(payload.success, true);
            assert.deepEqual(payload.counts, {
                entitlementsReceived: 2,
                created: 1,
                updated: 1,
                deleted: 0,
                preservedEnterprise: 0
            });
            assert.equal(syncCalls, 1);
        }
    );
});

test('license status returns pending before LMA sync arrives', async () => {
    let tokenIssueAttempts = 0;
    let syncAttempts = 0;
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByMiddlewareToken: async () => ({
                id: 2,
                org_id: '00DTEST',
                installation_id: 'inst-2',
                account_name: 'Acme',
                status: 'active'
            }),
            findSubscriberByOrgId: async () => null,
            issueSubscriberMiddlewareToken: async () => {
                tokenIssueAttempts++;
                return 'should-not-happen';
            },
            applyLmaLicenseSync: async () => {
                syncAttempts++;
                throw new Error('should not be called');
            }
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/refresh-license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({ orgId: '00DTEST' })
            });

            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.status, 'LICENSE_PENDING_LMA_SYNC');
            assert.deepEqual(payload.entitlements, []);
            assert.equal(tokenIssueAttempts, 0);
            assert.equal(syncAttempts, 0);
        }
    );
});

test('protected call without token is rejected', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ orgId: '00DTEST' })
            });

            assert.equal(response.status, 401);
        }
    );
});

test('license status returns pending when subscriber has no entitlements', async () => {
    let syncAttempts = 0;
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByMiddlewareToken: async () => ({
                id: 3,
                org_id: '00DTEST',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            findSubscriberByOrgId: async () => ({
                id: 3,
                org_id: '00DTEST',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            getEntitlementsForSubscriber: async () => [],
            applyLmaLicenseSync: async () => {
                syncAttempts++;
                throw new Error('should not be called');
            }
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/refresh-license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({ orgId: '00DTEST' })
            });

            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.status, 'LICENSE_PENDING_LMA_SYNC');
            assert.equal(payload.subscriber.orgId, '00DTEST');
            assert.deepEqual(payload.entitlements, []);
            assert.equal(syncAttempts, 0);
        }
    );
});

test('license status rejects token and org mismatch', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByMiddlewareToken: async () => ({
                id: 11,
                org_id: '00DMATCHED',
                installation_id: 'inst-11',
                account_name: 'Acme',
                status: 'active'
            })
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({ orgId: '00DOTHER' })
            });

            assert.equal(response.status, 403);
            const payload = await response.json();
            assert.equal(payload.error, 'Subscriber token does not match the requested org.');
        }
    );
});

test('license status returns product-not-found for missing expected products', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByMiddlewareToken: async () => ({
                id: 3,
                org_id: '00DTEST',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            findSubscriberByOrgId: async () => ({
                id: 3,
                org_id: '00DTEST',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            getEntitlementsForSubscriber: async () => ([
                {
                    product_name: PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR],
                    edition: 'paid',
                    is_active: true,
                    trial_start_date: null,
                    trial_end_date: null,
                    middleware_enabled: true,
                    enterprise_enabled: false,
                    metadata: {}
                }
            ])
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({ orgId: '00DTEST' })
            });

            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.message.includes('PRODUCT_NOT_FOUND'), true);
            assert.equal(payload.entitlements[0].edition, 'Paid');
            const missing = payload.entitlements.find(
                (entry) => entry.productName === PRODUCT_NAMES[PRODUCT_CODES.DASHBOARD_NARRATOR]
            );
            assert.equal(missing.status, 'PRODUCT_NOT_FOUND');
            assert.equal(missing.edition, 'LICENSE_PENDING_LMA_SYNC');
            assert.equal(payload.message.includes('trial expired'), false);
        }
    );
});

test('license status fails if backend entitlement rows drift to an unknown product', async () => {
    let syncCalls = 0;
    await withServer(
        {
            isDatabaseConfigured: () => true,
            findSubscriberByMiddlewareToken: async () => ({
                id: 3,
                org_id: '00DTEST',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            findSubscriberByOrgId: async () => ({
                id: 3,
                org_id: '00DTEST',
                installation_id: 'inst-1',
                account_name: 'Acme',
                status: 'active'
            }),
            getEntitlementsForSubscriber: async () => ([
                {
                    product_name: 'Report Narrator',
                    edition: 'Paid',
                    is_active: true,
                    trial_start_date: null,
                    trial_end_date: null,
                    middleware_enabled: true,
                    enterprise_enabled: false,
                    metadata: {}
                },
                {
                    product_name: 'Unknown Product',
                    edition: 'Paid',
                    is_active: true,
                    trial_start_date: null,
                    trial_end_date: null,
                    middleware_enabled: true,
                    enterprise_enabled: false,
                    metadata: {}
                }
            ]),
            applyLmaLicenseSync: async () => {
                syncCalls++;
                throw new Error('should not be called');
            }
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({ orgId: '00DTEST' })
            });

            assert.equal(response.status, 500);
            const payload = await response.json();
            assert.equal(payload.error, 'Unsupported license-status product: Unknown Product');
            assert.equal(syncCalls, 0);
        }
    );
});

test('lma license sync rejects unknown product names', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            lmaSyncSecret: 'lma-secret',
            applyLmaLicenseSync: async () => {
                throw new Error('Unsupported product entitlement: Unknown Product');
            }
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/lma/license-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-aias-lma-secret': 'lma-secret'
                },
                body: JSON.stringify({
                    orgId: '00DTEST',
                    packageName: 'AI Analyst Suite',
                    licenseStatus: 'Trial'
                })
            });

            assert.equal(response.status, 500);
            const payload = await response.json();
            assert.equal(payload.error, 'Unsupported product entitlement: Unknown Product');
        }
    );
});

test('lma license sync rejects invalid secret', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            lmaSyncSecret: 'lma-secret'
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/lma/license-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-aias-lma-secret': 'wrong-secret'
                },
                body: JSON.stringify({
                    orgId: '00DTEST',
                    packageName: 'AI Analyst Suite',
                    licenseStatus: 'Trial'
                })
            });

            assert.equal(response.status, 401);
        }
    );
});

test('lma license sync rejects missing orgId', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            lmaSyncSecret: 'lma-secret'
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/lma/license-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-aias-lma-secret': 'lma-secret'
                },
                body: JSON.stringify({
                    packageName: 'AI Analyst Suite',
                    licenseStatus: 'Trial'
                })
            });

            assert.equal(response.status, 400);
            const payload = await response.json();
            assert.equal(payload.error, 'orgId is required');
        }
    );
});

test('narrate rejects product and operation drift', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            openAiApiKey: 'test-key',
            findSubscriberByMiddlewareToken: async () => ({
                id: 12,
                org_id: '00DTEST',
                installation_id: 'inst-12',
                account_name: 'Acme',
                status: 'active'
            })
        },
        async (baseUrl) => {
            const unknownProductResponse = await fetch(`${baseUrl}/api/narrate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({
                    orgId: '00DTEST',
                    product: 'AI Analyst Suite',
                    operation: 'reportNarration',
                    edition: 'Paid',
                    model: 'gpt-4.1-mini',
                    payload: { input: 'hello' }
                })
            });
            assert.equal(unknownProductResponse.status, 400);

            const mismatchedOperationResponse = await fetch(`${baseUrl}/api/narrate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({
                    orgId: '00DTEST',
                    product: PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR],
                    operation: 'dashboardNarration',
                    edition: 'Paid',
                    model: 'gpt-4.1-mini',
                    payload: { input: 'hello' }
                })
            });
            assert.equal(mismatchedOperationResponse.status, 400);
        }
    );
});

test('narrate rejects subscriber token and org mismatch', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            openAiApiKey: 'test-key',
            findSubscriberByMiddlewareToken: async () => ({
                id: 15,
                org_id: '00DREALORG',
                installation_id: 'inst-15',
                account_name: 'Mismatch Co',
                status: 'active'
            })
        },
        async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/narrate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'subscriber-token'
                },
                body: JSON.stringify({
                    orgId: '00DOTHERORG',
                    product: PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR],
                    operation: 'reportNarration',
                    edition: 'Paid',
                    model: 'gpt-4.1-mini',
                    payload: { input: 'hello' }
                })
            });

            assert.equal(response.status, 403);
            const payload = await response.json();
            assert.equal(payload.error, 'Subscriber token does not match the requested org.');
        }
    );
});

test('bootstrap accepts legacy and explicit bootstrap auth for backward compatibility', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            bootstrapSharedToken: 'bootstrap-secret',
            sharedToken: 'legacy-shared',
            allowLegacySharedToken: true,
            findSubscriberByOrgId: async () => null
        },
        async (baseUrl) => {
            const modernAccepted = await fetch(`${baseUrl}/api/subscriber-bootstrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-bootstrap-token': 'bootstrap-secret'
                },
                body: JSON.stringify({ orgId: '00DTEST00000001', packageName: 'AI Analyst Suite' })
            });
            assert.equal(modernAccepted.status, 200);

            const accepted = await fetch(`${baseUrl}/api/subscriber-bootstrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'legacy-shared'
                },
                body: JSON.stringify({ orgId: '00DTEST00000001', packageName: 'AI Analyst Suite' })
            });
            assert.equal(accepted.status, 200);
        }
    );
});

test('legacy shared token is rejected on protected refresh and narration routes', async () => {
    await withServer(
        {
            isDatabaseConfigured: () => true,
            sharedToken: 'legacy-shared',
            allowLegacySharedToken: true,
            openAiApiKey: 'test-key',
            findSubscriberByMiddlewareToken: async () => null
        },
        async (baseUrl) => {
            const refreshResponse = await fetch(`${baseUrl}/refresh-license-status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'legacy-shared'
                },
                body: JSON.stringify({ orgId: '00DTEST' })
            });
            assert.equal(refreshResponse.status, 401);

            const narrateResponse = await fetch(`${baseUrl}/api/narrate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-salesforce-token': 'legacy-shared'
                },
                body: JSON.stringify({
                    orgId: '00DTEST',
                    product: PRODUCT_NAMES[PRODUCT_CODES.REPORT_NARRATOR],
                    operation: 'reportNarration',
                    edition: 'Paid',
                    model: 'gpt-4.1-mini',
                    payload: { input: 'hello' }
                })
            });
            assert.equal(narrateResponse.status, 401);
        }
    );
});

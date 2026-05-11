import express from 'express';
import {
    applyLmaLicenseSync,
    checkDatabaseHealth,
    findSubscriberByMiddlewareToken,
    findSubscriberByOrgId,
    getEntitlementsForSubscriber,
    issueSubscriberMiddlewareToken,
    isDatabaseConfigured
} from './db.js';
import {
    assertKnownProductName,
    getKnownProductNames,
    isValidOperationForProduct
} from './productCatalog.js';

const LICENSE_PENDING_LMA_SYNC = 'LICENSE_PENDING_LMA_SYNC';
const PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND';
const PENDING_SETUP_MESSAGE = 'License setup is still in progress. Please refresh license status in a few minutes.';
const LEGACY_SHARED_TOKEN_DEPRECATION_DATE = '2026-09-30';
const EXPECTED_PACKAGE_NAME = 'AI Analyst Suite';

export function createApp(dependencies = {}) {
    const app = express();
    const port = dependencies.port || process.env.PORT || 10000;
    const openAiApiKey = dependencies.openAiApiKey ?? process.env.OPENAI_API_KEY;
    const sharedToken = dependencies.sharedToken ?? process.env.SALESFORCE_SHARED_TOKEN;
    const bootstrapSharedToken = dependencies.bootstrapSharedToken
        ?? process.env.BOOTSTRAP_SHARED_TOKEN
        ?? sharedToken;
    const lmaSyncSecret = dependencies.lmaSyncSecret ?? process.env.LMA_SYNC_SECRET;
    const allowLegacySharedToken = dependencies.allowLegacySharedToken
        ?? process.env.ALLOW_LEGACY_SHARED_TOKEN !== 'false';
    const dbConfigured = dependencies.isDatabaseConfigured || isDatabaseConfigured;
    const dbHealth = dependencies.checkDatabaseHealth || checkDatabaseHealth;
    const lookupSubscriberByToken = dependencies.findSubscriberByMiddlewareToken || findSubscriberByMiddlewareToken;
    const lookupSubscriberByOrgId = dependencies.findSubscriberByOrgId || findSubscriberByOrgId;
    const fetchEntitlementsForSubscriber = dependencies.getEntitlementsForSubscriber || getEntitlementsForSubscriber;
    const issueTokenForSubscriber = dependencies.issueSubscriberMiddlewareToken || issueSubscriberMiddlewareToken;
    const applySync = dependencies.applyLmaLicenseSync || applyLmaLicenseSync;
    const providerFetch = dependencies.fetchImpl || fetch;

    app.use(express.json({ limit: '2mb' }));

    function extractBearerToken(authorizationHeader) {
        if (!authorizationHeader || typeof authorizationHeader !== 'string') {
            return '';
        }
        const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
        return match ? match[1].trim() : '';
    }

    function logLegacySharedTokenUsage(routeName, orgId = '') {
        console.warn(
            `[legacy-shared-token] route=${routeName} orgId=${orgId || 'unknown'} deprecationDate=${LEGACY_SHARED_TOKEN_DEPRECATION_DATE}`
        );
    }

    async function requireSalesforceToken(req, res, next) {
        const inboundToken = (req.header('x-salesforce-token') || '').trim();
        if (!inboundToken) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized middleware request'
            });
        }

        const subscriber = await lookupSubscriberByToken(inboundToken);
        if (!subscriber) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized middleware request'
            });
        }

        req.authorizedSubscriber = subscriber;
        req.authorizationMode = 'subscriber-token';
        next();
    }

    function describeBootstrapAuth(req) {
        const inboundBootstrapToken = (req.header('x-bootstrap-token') || '').trim();
        const inboundSharedHeaderToken = (req.header('x-salesforce-token') || '').trim();
        const inboundBearerToken = extractBearerToken(req.header('authorization'));
        const candidateToken = inboundBootstrapToken || inboundBearerToken || inboundSharedHeaderToken;

        if (!candidateToken) {
            return 'unauthenticated-lma-synced-org';
        }

        if (bootstrapSharedToken && candidateToken === bootstrapSharedToken) {
            return inboundBootstrapToken
                ? 'bootstrap-header'
                : inboundBearerToken
                    ? 'bootstrap-bearer'
                    : 'bootstrap-shared-header';
        }

        if (allowLegacySharedToken && sharedToken && inboundSharedHeaderToken === sharedToken) {
            logLegacySharedTokenUsage(req.path, req.body?.orgId);
            return 'legacy-shared-token';
        }

        return 'invalid-auth';
    }

    function requireLmaSyncToken(req, res, next) {
        const inboundToken = (req.header('x-aias-lma-secret') || '').trim();
        if (lmaSyncSecret && inboundToken === lmaSyncSecret) {
            return next();
        }

        return res.status(401).json({
            success: false,
            error: 'Unauthorized LMA sync request'
        });
    }

    function buildProviderRequest(model, payload) {
        return {
            model,
            input: payload.input
        };
    }

    function toSalesforceEdition(edition) {
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
        if (edition === LICENSE_PENDING_LMA_SYNC) {
            return LICENSE_PENDING_LMA_SYNC;
        }
        return edition;
    }

    function normalizeEntitlements(entitlements) {
        return (entitlements || []).map((entitlement) => {
            assertKnownProductName(entitlement.product_name, 'license-status product');
            return {
                productName: entitlement.product_name,
                edition: toSalesforceEdition(entitlement.edition),
                isActive: entitlement.is_active,
                trialStartDate: entitlement.trial_start_date,
                trialEndDate: entitlement.trial_end_date,
                middlewareEnabled: entitlement.middleware_enabled,
                enterpriseEnabled: entitlement.enterprise_enabled,
                metadata: entitlement.metadata || {}
            };
        });
    }

    function buildPendingLicenseResponse() {
        return {
            success: true,
            status: LICENSE_PENDING_LMA_SYNC,
            message: PENDING_SETUP_MESSAGE,
            entitlements: []
        };
    }

    function isLikelySalesforceOrgId(value) {
        return typeof value === 'string' && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value.trim());
    }

    function buildMissingProductEntitlement(productName) {
        return {
            productName,
            status: PRODUCT_NOT_FOUND,
            edition: LICENSE_PENDING_LMA_SYNC,
            isActive: false,
            middlewareEnabled: false,
            enterpriseEnabled: false,
            metadata: {
                status: PRODUCT_NOT_FOUND
            }
        };
    }

    function enforceAuthorizedSubscriberOrg(req, requestedOrgId) {
        if (!req.authorizedSubscriber) {
            return null;
        }

        if (req.authorizedSubscriber.org_id !== requestedOrgId) {
            return {
                success: false,
                error: 'Subscriber token does not match the requested org.'
            };
        }

        return null;
    }

    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            service: 'ai-analyst-middleware',
            databaseConfigured: dbConfigured()
        });
    });

    app.get('/health/dependencies', async (_req, res) => {
        const database = await dbHealth();
        res.json({
            ok: database.healthy || !database.configured,
            service: 'ai-analyst-middleware',
            openAiConfigured: Boolean(openAiApiKey),
            database
        });
    });

    app.post('/lma/license-sync', requireLmaSyncToken, async (req, res) => {
        try {
            if (!dbConfigured()) {
                return res.status(500).json({
                    success: false,
                    error: 'Middleware is missing DATABASE_URL'
                });
            }

            const requestPayload = req.body || {};
            const trimmedOrgId = typeof requestPayload.orgId === 'string' ? requestPayload.orgId.trim() : '';
            const trimmedPackageName = typeof requestPayload.packageName === 'string' ? requestPayload.packageName.trim() : '';
            const trimmedLicenseStatus = typeof requestPayload.licenseStatus === 'string' ? requestPayload.licenseStatus.trim() : '';

            if (!trimmedOrgId) {
                return res.status(400).json({
                    success: false,
                    error: 'orgId is required'
                });
            }
            if (!trimmedPackageName) {
                return res.status(400).json({
                    success: false,
                    error: 'packageName is required'
                });
            }
            if (!trimmedLicenseStatus) {
                return res.status(400).json({
                    success: false,
                    error: 'licenseStatus is required'
                });
            }

            console.info(
                `[lma-license-sync] orgId=${trimmedOrgId} packageName=${trimmedPackageName} licenseStatus=${trimmedLicenseStatus}`
            );

            const result = await applySync({
                ...requestPayload,
                orgId: trimmedOrgId,
                packageName: trimmedPackageName,
                licenseStatus: trimmedLicenseStatus
            });
            return res.json({
                success: true,
                message: 'LMA license sync applied.',
                subscriber: {
                    orgId: result.subscriber.org_id,
                    installationId: result.subscriber.installation_id,
                    accountName: result.subscriber.account_name,
                    status: result.subscriber.status
                },
                counts: {
                    entitlementsReceived: result.entitlementCount,
                    created: result.createdCount,
                    updated: result.updatedCount,
                    deleted: result.deletedCount,
                    preservedEnterprise: result.preservedEnterpriseCount || 0
                }
            });
        } catch (error) {
            const statusCode = ['orgId is required', 'packageName is required', 'licenseStatus is required']
                .includes(error.message) || error.message?.startsWith('Unsupported licenseStatus')
                ? 400
                : 500;
            return res.status(statusCode).json({
                success: false,
                error: error.message || 'Unexpected LMA license-sync error'
            });
        }
    });

    app.post('/api/subscriber-bootstrap', async (req, res) => {
        try {
            if (!dbConfigured()) {
                return res.status(500).json({
                    success: false,
                    error: 'Middleware is missing DATABASE_URL'
                });
            }

            const requestPayload = req.body || {};
            const orgId = typeof requestPayload.orgId === 'string' ? requestPayload.orgId.trim() : '';
            const packageName = typeof requestPayload.packageName === 'string' ? requestPayload.packageName.trim() : '';
            if (!orgId) {
                return res.status(400).json({
                    success: false,
                    error: 'orgId is required'
                });
            }

            if (!isLikelySalesforceOrgId(orgId)) {
                return res.status(400).json({
                    success: false,
                    error: 'orgId format is invalid'
                });
            }

            if (packageName && packageName !== EXPECTED_PACKAGE_NAME) {
                return res.status(400).json({
                    success: false,
                    error: `Unsupported packageName: ${packageName}`
                });
            }

            const bootstrapAuthorizationMode = describeBootstrapAuth(req);
            if (bootstrapAuthorizationMode === 'invalid-auth') {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized bootstrap request'
                });
            }

            const subscriber = await lookupSubscriberByOrgId(orgId);
            if (!subscriber) {
                return res.json(buildPendingLicenseResponse());
            }

            const middlewareToken = await issueTokenForSubscriber(subscriber.id);
            if (!middlewareToken) {
                throw new Error('Failed to issue subscriber middleware token.');
            }
            console.info(
                `[subscriber-bootstrap] orgId=${subscriber.org_id} authMode=${bootstrapAuthorizationMode} tokenIssued=true`
            );
            return res.json({
                success: true,
                middlewareToken,
                rotationPolicy: 'rotate_on_bootstrap',
                subscriber: {
                    orgId: subscriber.org_id,
                    installationId: subscriber.installation_id,
                    accountName: subscriber.account_name,
                    status: subscriber.status
                }
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error.message || 'Unexpected subscriber-bootstrap error'
            });
        }
    });

    app.post('/api/narrate', requireSalesforceToken, async (req, res) => {
        try {
            const { product, operation, edition, model, payload, orgId } = req.body || {};

            if (!product || !operation || !edition || !model || !payload?.input) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields'
                });
            }

            const subscriberOrgError = enforceAuthorizedSubscriberOrg(req, orgId);
            if (orgId && subscriberOrgError) {
                return res.status(403).json(subscriberOrgError);
            }

            try {
                assertKnownProductName(product, 'narration product');
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    error: error.message
                });
            }

            if (!isValidOperationForProduct(product, operation)) {
                return res.status(400).json({
                    success: false,
                    error: `Unsupported narration operation for ${product}: ${operation}`
                });
            }

            if (!openAiApiKey) {
                return res.status(500).json({
                    success: false,
                    error: 'Middleware is missing OPENAI_API_KEY'
                });
            }

            const providerResponse = await providerFetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${openAiApiKey}`
                },
                body: JSON.stringify(buildProviderRequest(model, payload))
            });

            const providerBodyText = await providerResponse.text();
            let providerJson = null;
            try {
                providerJson = providerBodyText ? JSON.parse(providerBodyText) : null;
            } catch (parseError) {
                console.error('[middleware] OpenAI response was not JSON', parseError.message);
            }

            if (!providerResponse.ok) {
                return res.status(providerResponse.status).json({
                    success: false,
                    error: 'AI provider request failed',
                    providerStatus: providerResponse.status
                });
            }

            return res.json({
                success: true,
                product,
                operation,
                edition,
                usage: providerJson?.usage || null,
                providerResponse: providerJson
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error.message || 'Unexpected middleware error'
            });
        }
    });

    async function handleRefreshLicenseStatus(req, res) {
        try {
            if (!dbConfigured()) {
                return res.status(500).json({
                    success: false,
                    error: 'Middleware is missing DATABASE_URL'
                });
            }

            const { orgId } = req.body || {};
            if (!orgId) {
                return res.status(400).json({
                    success: false,
                    error: 'orgId is required'
                });
            }

            const subscriberOrgError = enforceAuthorizedSubscriberOrg(req, orgId);
            if (subscriberOrgError) {
                return res.status(403).json(subscriberOrgError);
            }

            const subscriber = await lookupSubscriberByOrgId(orgId);
            if (!subscriber) {
                return res.json(buildPendingLicenseResponse());
            }

            const entitlements = normalizeEntitlements(await fetchEntitlementsForSubscriber(subscriber.id));
            if (entitlements.length === 0) {
                return res.json({
                    ...buildPendingLicenseResponse(),
                    subscriber: {
                        orgId: subscriber.org_id,
                        installationId: subscriber.installation_id,
                        accountName: subscriber.account_name,
                        status: subscriber.status
                    }
                });
            }

            const returnedProductNames = new Set(entitlements.map((entitlement) => entitlement.productName));
            const missingProducts = getKnownProductNames().filter(
                (productName) => !returnedProductNames.has(productName)
            );
            const responseEntitlements = entitlements.concat(
                missingProducts.map((productName) => buildMissingProductEntitlement(productName))
            );
            const responsePayload = {
                success: true,
                subscriber: {
                    orgId: subscriber.org_id,
                    installationId: subscriber.installation_id,
                    accountName: subscriber.account_name,
                    status: subscriber.status
                },
                entitlements: responseEntitlements
            };
            if (missingProducts.length > 0) {
                responsePayload.message = `PRODUCT_NOT_FOUND: Missing entitlement rows for ${missingProducts.join(', ')}.`;
            }

            return res.json(responsePayload);
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error.message || 'Unexpected license-status error'
            });
        }
    }

    app.post('/api/license-status', requireSalesforceToken, handleRefreshLicenseStatus);
    app.post('/refresh-license-status', requireSalesforceToken, handleRefreshLicenseStatus);

    return { app, port };
}

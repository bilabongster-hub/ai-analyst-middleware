import express from 'express';
import { randomUUID } from 'crypto';
import {
    checkDatabaseHealth,
    findSubscriberByMiddlewareToken,
    findSubscriberByOrgId,
    getEntitlementsForSubscriber,
    getPool,
    isDatabaseConfigured
} from './db.js';

const app = express();
const port = process.env.PORT || 10000;
const openAiApiKey = process.env.OPENAI_API_KEY;
const sharedToken = process.env.SALESFORCE_SHARED_TOKEN;

app.use(express.json({ limit: '2mb' }));

async function requireSalesforceToken(req, res, next) {
    const inboundToken = (req.header('x-salesforce-token') || '').trim();
    if (!inboundToken) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized middleware request'
        });
    }

    if (sharedToken && inboundToken === sharedToken) {
        req.authorizedSubscriber = null;
        return next();
    }

    const subscriber = await findSubscriberByMiddlewareToken(inboundToken);
    if (!subscriber) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized middleware request'
        });
    }

    req.authorizedSubscriber = subscriber;

    next();
}

function buildProviderRequest(model, payload) {
    return {
        model,
        input: payload.input
    };
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'ai-analyst-middleware',
        databaseConfigured: isDatabaseConfigured()
    });
});

app.get('/health/dependencies', async (_req, res) => {
    const database = await checkDatabaseHealth();
    res.json({
        ok: database.healthy || !database.configured,
        service: 'ai-analyst-middleware',
        openAiConfigured: Boolean(openAiApiKey),
        database
    });
});
async function ensureSubscriberMiddlewareToken(subscriberId) {
    const existing = await getPool().query(
        `
        SELECT middleware_token
        FROM subscribers
        WHERE id = $1
        LIMIT 1
        `,
        [subscriberId]
    );

    const existingToken = existing.rows[0]?.middleware_token;
    if (existingToken) {
        return existingToken;
    }

    const newToken = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;

    await getPool().query(
        `
        UPDATE subscribers
        SET middleware_token = $1
        WHERE id = $2
        `,
        [newToken, subscriberId]
    );

    return newToken;
}

app.post('/api/subscriber-bootstrap', async (req, res) => {
    try {
        if (!isDatabaseConfigured()) {
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

        const subscriber = await findSubscriberByOrgId(orgId);
        if (!subscriber) {
            return res.status(404).json({
                success: false,
                error: 'Subscriber org not found'
            });
        }

        const middlewareToken = await ensureSubscriberMiddlewareToken(subscriber.id);
        const entitlements = await getEntitlementsForSubscriber(subscriber.id);

        return res.json({
            success: true,
            middlewareToken,
            subscriber: {
                orgId: subscriber.org_id,
                installationId: subscriber.installation_id,
                accountName: subscriber.account_name,
                status: subscriber.status
            },
            entitlements: entitlements.map((entitlement) => ({
                productName: entitlement.product_name,
                edition: entitlement.edition,
                isActive: entitlement.is_active,
                trialStartDate: entitlement.trial_start_date,
                trialEndDate: entitlement.trial_end_date,
                middlewareEnabled: entitlement.middleware_enabled,
                enterpriseEnabled: entitlement.enterprise_enabled,
                metadata: entitlement.metadata || {}
            }))
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
        if (!openAiApiKey) {
            return res.status(500).json({
                success: false,
                error: 'Middleware is missing OPENAI_API_KEY'
            });
        }

        const { product, operation, edition, model, payload } = req.body || {};

        if (!product || !operation || !edition || !model || !payload?.input) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const providerResponse = await fetch('https://api.openai.com/v1/responses', {
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

app.post('/api/license-status', requireSalesforceToken, async (req, res) => {
    try {
        if (!isDatabaseConfigured()) {
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

        const subscriber = await findSubscriberByOrgId(orgId);
        if (!subscriber) {
            return res.status(404).json({
                success: false,
                error: 'Subscriber org not found'
            });
        }

        const entitlements = await getEntitlementsForSubscriber(subscriber.id);
        return res.json({
            success: true,
            subscriber: {
                orgId: subscriber.org_id,
                installationId: subscriber.installation_id,
                accountName: subscriber.account_name,
                status: subscriber.status
            },
            entitlements: entitlements.map((entitlement) => ({
                productName: entitlement.product_name,
                edition: entitlement.edition,
                isActive: entitlement.is_active,
                trialStartDate: entitlement.trial_start_date,
                trialEndDate: entitlement.trial_end_date,
                middlewareEnabled: entitlement.middleware_enabled,
                enterpriseEnabled: entitlement.enterprise_enabled,
                metadata: entitlement.metadata || {}
            }))
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message || 'Unexpected license-status error'
        });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`AI Analyst middleware listening on port ${port}`);
});

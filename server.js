import express from 'express';

const app = express();
const port = process.env.PORT || 10000;
const openAiApiKey = process.env.OPENAI_API_KEY;
const sharedToken = process.env.SALESFORCE_SHARED_TOKEN;

app.use(express.json({ limit: '2mb' }));

function requireSharedToken(req, res, next) {
    if (!sharedToken) {
        return res.status(500).json({
            success: false,
            error: 'Middleware is missing SALESFORCE_SHARED_TOKEN'
        });
    }

    const inboundToken = (req.header('x-salesforce-token') || '').trim();
    if (inboundToken !== sharedToken) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized middleware request'
        });
    }

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
        service: 'ai-analyst-middleware'
    });
});

app.post('/api/narrate', requireSharedToken, async (req, res) => {
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

        const providerJson = await providerResponse.json();

        if (!providerResponse.ok) {
            return res.status(providerResponse.status).json({
                success: false,
                error: providerJson?.error?.message || 'OpenAI request failed'
            });
        }

        return res.json({
            success: true,
            product,
            operation,
            edition,
            usage: providerJson.usage || null,
            providerResponse: providerJson
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message || 'Unexpected middleware error'
        });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`AI Analyst middleware listening on port ${port}`);
});

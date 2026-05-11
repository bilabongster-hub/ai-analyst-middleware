import { createApp } from './app.js';

const { app, port } = createApp();

app.listen(port, '0.0.0.0', () => {
    console.log(`AI Analyst middleware listening on port ${port}`);
});

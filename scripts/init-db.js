import { initializeDatabase } from '../db.js';

try {
    await initializeDatabase();
    console.log('Database schema initialized successfully.');
    process.exit(0);
} catch (error) {
    console.error('Failed to initialize database schema:', error.message);
    process.exit(1);
}

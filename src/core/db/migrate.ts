import { getDb, closeDb } from './index';

console.log('Starting database migration...');

try {
    getDb();
    console.log('Database migration completed');
} catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
} finally {
    closeDb();
}

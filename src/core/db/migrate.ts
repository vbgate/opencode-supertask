import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, closeDb } from './index';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '../../drizzle');

console.log('Starting database migration...');

try {
    const db = getDb();
    migrate(db, { migrationsFolder });
    console.log('Database migration completed');
} catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
} finally {
    closeDb();
}

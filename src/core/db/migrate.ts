// 数据库迁移脚本
// 运行: bun run db:migrate

import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db, closeDb } from './index';

import { join } from 'path';

console.log('🔄 开始数据库迁移...');

try {
    const migrationsFolder = join(process.cwd(), 'drizzle');
    migrate(db, { migrationsFolder });
    console.log('✅ 数据库迁移完成');
} catch (error) {
    console.error('❌ 迁移失败:', error);
    process.exit(1);
} finally {
    closeDb();
}

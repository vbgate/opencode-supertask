import { db, closeDb } from '@core/db';
import { tasks } from '@core/db/schema';
import { inArray } from 'drizzle-orm';

async function main() {
    console.log('🔄 正在重置任务状态 (Running/Failed -> Pending)...');

    // SQLite 驱动下，run() 返回结果包含 changes
    const result = await db.update(tasks)
        .set({
            status: 'pending',
            startedAt: null,
            finishedAt: null
        })
        .where(inArray(tasks.status, ['running', 'failed']))
        .run();

    console.log(`✅ 操作完成。`);

    closeDb();
}

main().catch(console.error);

// 数据库连接模块 (使用 Bun 内置 SQLite)
// 数据库存放在 ~/.local/share/opencode/tasks.db

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

// 数据库文件路径（统一存放在 OpenCode 数据目录）
const DB_PATH = join(homedir(), '.local/share/opencode/tasks.db');

// 确保目录存在
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

// 创建 SQLite 连接
const sqlite = new Database(DB_PATH);

// 启用 WAL 模式提升性能
sqlite.exec('PRAGMA journal_mode = WAL;');

// 创建 Drizzle 实例
export const db = drizzle(sqlite, { schema });

// 导出 schema 方便使用
export { schema };

// 关闭数据库连接
export function closeDb() {
    sqlite.close();
}

// 导出数据库路径（供调试）
export const DB_FILE_PATH = DB_PATH;

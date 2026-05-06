import { glob } from 'glob';
import { existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { TaskService } from '@core/services/task.service';
import { closeDb } from '@core/db';

// 配置
const LANGUAGES = [
    { code: 'en', name: '英文' },
    { code: 'ja', name: '日文' },
    { code: 'ko', name: '韩文' },
    { code: 'de', name: '德文' },
    { code: 'es', name: '西班牙文' },
    { code: 'fr', name: '法文' },
    { code: 'pt', name: '葡萄牙文' },
    { code: 'ru', name: '俄文' },
    { code: 'zh-tw', name: '繁体中文' }
];

// 根目录
const PROJECT_ROOT = '/Users/javazys/code/opencodedocs';
const ZH_DOCS_ROOT = join(PROJECT_ROOT, 'site/docs/zh');

async function main() {
    console.log(`🔍 开始扫描中文文档: ${ZH_DOCS_ROOT} `);

    // 1. 获取现有任务名称，用于去重
    console.log('📊 正在获取现有任务列表...');
    const allTasks = await TaskService.list({ limit: 10000 }); // 获取足够多的任务
    const existTaskNames = new Set(allTasks.map(t => t.name));
    console.log(`✅ 已存在 ${existTaskNames.size} 个任务`);

    // 2. 扫描所有 .md 文件
    const files = await glob('**/*.md', { cwd: ZH_DOCS_ROOT });
    console.log(`📄 找到 ${files.length} 个中文文档`);

    let taskCount = 0;
    const BATCH_ID = `translate - batch - ${Date.now()} `;

    for (const file of files) {
        const sourcePath = join('site/docs/zh', file);

        for (const lang of LANGUAGES) {
            let targetPath;
            if (lang.code === 'en') {
                targetPath = join('site/docs', file);
            } else {
                targetPath = join('site/docs', lang.code, file);
            }

            const targetAbsPath = join(PROJECT_ROOT, targetPath);

            // 检查目标文件是否存在
            if (existsSync(targetAbsPath)) {
                continue;
            }

            // 检查任务是否已存在
            const taskName = `翻译 ${file} 为${lang.name} `;
            if (existTaskNames.has(taskName)) {
                // console.log(`⏩[${ lang.code }] 任务已存在: ${ taskName } `);
                continue;
            }



            console.log(`🆕[${lang.code}] 创建任务: ${taskName} `);

            const prompt = `请将中文教程页面翻译为${lang.name}：

源文件：${sourcePath}
目标语言：${lang.code}（${lang.name}）

要求：
1. 保持 Markdown 格式和 Front Matter 结构不变
2. 准确翻译内容，保持技术术语的一致性
3. ${lang.name} 输出目录：${targetPath}
4. 如果目标目录不存在，请先创建目录结构`;

            // 直接调用 Service 创建任务
            await TaskService.add({
                name: taskName,
                agent: 'localize-gen',
                model: 'zhipuai-coding-plan/glm-4.7',
                prompt: prompt,
                category: 'translation',
                importance: 3,
                urgency: 3,
                batchId: BATCH_ID,
                cwd: PROJECT_ROOT,
                status: 'pending'
            });

            taskCount++;
        }
    }

    console.log(`\n\n🎉 扫描完成！`);
    console.log(`📦 批次 ID: ${BATCH_ID} `);
    console.log(`➕ 新增任务: ${taskCount} 个`);

    closeDb();
}

main().catch(console.error);

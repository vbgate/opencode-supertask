import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { spawn } from 'child_process';
import { closeDb } from '@core/db';

const DEFAULT_MODEL = 'zhipuai-coding-plan/glm-4.7';

/**
 * 执行 opencode 命令并捕获 sessionId
 * @param onSessionId 捕获到 sessionId 时的回调（实时写入数据库）
 */
function runOpencode(
    cmd: string, 
    cwd: string,
    onSessionId?: (sessionId: string) => void
): Promise<{ success: boolean; sessionId?: string; output: string }> {
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', cmd], { 
            cwd,
            stdio: ['inherit', 'pipe', 'pipe']  // stdin 继承，stdout/stderr 捕获
        });
        let output = '';
        let sessionId: string | undefined;

        const handleData = (data: Buffer) => {
            const text = data.toString();
            output += text;
            process.stdout.write(text); // 实时输出到控制台

            // 解析 sessionId（从 JSON 输出中提取）
            if (!sessionId) {
                const match = text.match(/"sessionID"\s*:\s*"(ses_[^"]+)"/);
                if (match) {
                    sessionId = match[1];
                    // 立即回调写入数据库
                    onSessionId?.(sessionId);
                }
            }
        };

        child.stdout?.on('data', handleData);
        child.stderr?.on('data', handleData);

        child.on('close', (code) => {
            resolve({
                success: code === 0,
                sessionId,
                output,
            });
        });

        child.on('error', (err) => {
            resolve({
                success: false,
                output: output + '\n' + err.message,
            });
        });
    });
}

async function main() {
    // 解析命令行参数
    const args = process.argv.slice(2);
    let overrideModel = '';

    // 简单的手动解析，为了��引入额外依赖
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--model' || args[i] === '-m') {
            overrideModel = args[i + 1];
        }
    }

    console.log('👷 SuperTask Worker 启动...');
    if (overrideModel) {
        console.log(`⚠️  强制覆盖模型为: ${overrideModel}`);
    } else {
        console.log('模式: 使用任务自带模型配置');
    }

    let processedCount = 0;

    while (true) {
        try {
            console.log('🔄 正在查询下一个任务...');
            // 1. 获取下一个任务（全局，不按 cwd 过滤）
            const task = await TaskService.next();

            if (!task) {
                console.log('zzz 暂无待执行任务。休息 5 秒...');
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            console.log(`\n🔍 发现任务 [${task.id}] ${task.name}`);

            // 2. 尝试抢占任务 (乐观锁，不按 cwd 过滤)
            const runningTask = await TaskService.start(task.id);
            if (!runningTask) {
                console.log('⚠️ 任务已被其他 Worker 抢占，跳过...');
                continue;
            }

            console.log(`🚀 [任务 ${task.id}] 抢占成功，开始执行...`);
            console.log(`> Agent: ${task.agent}`);

            // 确定使用的模型
            const rawModel = overrideModel || task.model;
            const modelToUse = rawModel && rawModel !== 'default' ? rawModel : DEFAULT_MODEL;
            console.log(`> Model: ${modelToUse}${overrideModel ? ' (覆盖)' : ''}`);

            // 3. 创建执行记录
            const run = await TaskRunService.create({
                taskId: task.id,
                model: modelToUse,
                status: 'running',
            });
            console.log(`> Run ID: ${run.id}`);

            // 4. 调用 opencode run 执行
            const cmd = `opencode run --agent supertask-runner -m "${modelToUse}" --format json "执行任务 ID: ${task.id} OVERRIDE_MODEL=${modelToUse}"`;
            const cwd = task.cwd || process.cwd();
            console.log(`> CWD: ${cwd}${task.cwd ? '' : ' (fallback: worker process.cwd)'}`);

            const result = await runOpencode(cmd, cwd, async (sessionId) => {
                // 实时写入 sessionId
                await TaskRunService.updateSessionId(run.id, sessionId);
                console.log(`> Session: ${sessionId}`);
            });

            // 6. 更新执行记录状态
            if (result.success) {
                await TaskRunService.done(run.id);
                processedCount++;
            } else {
                await TaskRunService.fail(run.id, result.output.slice(-2000)); // 保留最后 2000 字符

                // 检查任务状态，如果还在 running，标记为 failed
                const currentStatus = await TaskService.getById(task.id);
                if (currentStatus?.status === 'running') {
                    console.log(`🧹 从 Running 状态恢复为 Failed...`);
                    await TaskService.fail(task.id, "Worker执行异常：Opencode 进程非正常退出");
                }
            }

        } catch (error) {
            console.error('Worker 发生错误:', error);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log(`\n🎉 工作完成！共处理 ${processedCount} 个任务。`);
    closeDb();
    process.exit(0);
}

main();

/** @jsx Hono.jsx */
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { html } from 'hono/html';
import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { desc, sql } from 'drizzle-orm';

const app = new Hono();

// 简单的 CSS 样式
const styles = html`
<style>
  :root {
    --bg-color: #0d1117;
    --card-bg: #161b22;
    --border-color: #30363d;
    --text-primary: #c9d1d9;
    --text-secondary: #8b949e;
    --accent: #238636;
    --danger: #da3633;
    --warning: #d29922;
    --info: #1f6feb;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background-color: var(--bg-color);
    color: var(--text-primary);
    margin: 0;
    padding: 0;
    line-height: 1.5;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 16px;
  }
  h1 { font-size: 24px; margin: 0; color: #fff; }
  
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }
  .stat-card {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 20px;
    text-align: center;
  }
  .stat-value { font-size: 32px; font-weight: bold; color: #fff; }
  .stat-label { color: var(--text-secondary); font-size: 14px; text-transform: uppercase; }

  .task-list {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border-color);
  }
  th {
    background: #21262d;
    color: var(--text-secondary);
    font-weight: 600;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: rgba(255,255,255,0.02); }

  .status-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid transparent;
  }
  .status-pending { background: rgba(110,118,129,0.4); color: #8b949e; border-color: rgba(240,246,252,0.1); }
  .status-running { background: rgba(56,139,253,0.15); color: #58a6ff; border-color: rgba(56,139,253,0.4); }
  .status-done { background: rgba(46,160,67,0.15); color: #3fb950; border-color: rgba(46,160,67,0.4); }
  .status-failed { background: rgba(248,81,73,0.15); color: #f85149; border-color: rgba(248,81,73,0.4); }

  .action-btn {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    margin-right: 4px;
  }
  .action-btn:hover { background: #30363d; color: #fff; }
  .btn-retry:hover { color: var(--warning); border-color: var(--warning); }
  .btn-delete:hover { color: var(--danger); border-color: var(--danger); }
  .refresh-btn {
    background: var(--accent);
    color: white;
    border: none;
    padding: 6px 16px;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
  }
  .refresh-btn:hover { opacity: 0.9; }
</style>
`;

const Layout = (props: { title: string, children: any }) => html`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${props.title} - SuperTask</title>
  ${styles}
  <script>
    setInterval(() => {
        // window.location.reload(); 
    }, 10000);

    async function retryTask(id) {
        if(!confirm('确定重试任务 #' + id + '?')) return;
        await fetch('/api/tasks/' + id + '/retry', { method: 'POST' });
        window.location.reload();
    }
    async function deleteTask(id) {
        if(!confirm('确定删除任务 #' + id + '?')) return;
        await fetch('/api/tasks/' + id, { method: 'DELETE' });
        window.location.reload();
    }
    async function showDetail(id) {
        try {
            const res = await fetch('/api/tasks/' + id);
            const task = await res.json();
            const content = document.getElementById('dialog-content');
            content.textContent = JSON.stringify(task, null, 2);
            document.getElementById('detail-dialog').showModal();
        } catch(e) {
            alert('获取详情失败');
        }
    }
  </script>
  <style>
    dialog {
        background: var(--card-bg);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 0;
        max-width: 800px;
        width: 90%;
    }
    dialog::backdrop {
        background: rgba(0,0,0,0.6);
    }
    .dialog-header {
        padding: 16px;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .dialog-body {
        padding: 16px;
        max-height: 70vh;
        overflow-y: auto;
    }
    pre {
        margin: 0;
        white-space: pre-wrap;
        font-family: monospace;
    }
    .close-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    ${props.children}
  </div>
</body>
</html>
`;

app.get('/', async (c) => {
  const page = Number(c.req.query('page') || '1');
  const limit = 100;
  const offset = (page - 1) * limit;

  // 并行获取列表和统计信息（不按 cwd 过滤，显示所有任务）
  const [tasks, statsData] = await Promise.all([
    TaskService.list({ limit, offset }),
    TaskService.stats({})
  ]);

  // 批量获取任务的最新执行记录
  const taskIds = tasks.map(t => t.id);
  const latestRuns = await TaskRunService.getLatestByTaskIds(taskIds);

  const counts = {
    pending: statsData.pending || 0,
    running: statsData.running || 0,
    done: statsData.done || 0,
    failed: statsData.failed || 0,
    total: statsData.total || 0
  };

  return c.html(
    <Layout title="Dashboard">
      <header>
        <div>
          <h1>🚀 SuperTask Dashboard</h1>
          <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>高性能任务调度中心</span>
        </div>
        <div>
          <a href="/" class="refresh-btn">🔄 刷新</a>
        </div>
      </header>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value" style={{ color: 'var(--text-secondary)' }}>{counts.pending}</div>
          <div class="stat-label">Pending</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style={{ color: 'var(--info)' }}>{counts.running}</div>
          <div class="stat-label">Running</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style={{ color: 'var(--accent)' }}>{counts.done}</div>
          <div class="stat-label">Done</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style={{ color: 'var(--danger)' }}>{counts.failed}</div>
          <div class="stat-label">Failed</div>
        </div>
      </div>

      <div class="task-list">
        <table>
          <thead>
            <tr>
              <th width="60">ID</th>
              <th>任务名称</th>
              <th>Agent</th>
              <th width="100">状态</th>
              <th width="80">耗时</th>
              <th width="80">重试</th>
              <th width="180">Session</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(task => {
              // 计算耗时
              let duration = '-';
              if (task.startedAt) {
                const start = new Date(task.startedAt).getTime();
                const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
                const seconds = Math.floor((end - start) / 1000);
                if (seconds < 60) {
                  duration = `${seconds}s`;
                } else if (seconds < 3600) {
                  const m = Math.floor(seconds / 60);
                  const s = seconds % 60;
                  duration = `${m}m${s}s`;
                } else {
                  const h = Math.floor(seconds / 3600);
                  const m = Math.floor((seconds % 3600) / 60);
                  duration = `${h}h${m}m`;
                }
              }
              // 获取最新执行记录的 sessionId
              const latestRun = latestRuns.get(task.id);
              const sessionId = latestRun?.sessionId;
              // 显示前3位***后3位
              const shortSession = sessionId 
                ? `${sessionId.slice(4, 7)}***${sessionId.slice(-3)}` 
                : '-';
              const copyCmd = sessionId ? `opencode -s ${sessionId}` : '';
              return (
              <tr>
                <td style={{ color: 'var(--text-secondary)' }}>#{task.id}</td>
                <td>
                  <div style={{ fontWeight: 500 }}>{task.name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '500px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {task.prompt.substring(0, 100)}...
                  </div>
                </td>
                <td><span style={{ background: '#21262d', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>{task.agent}</span></td>
                <td><span class={`status-badge status-${task.status}`}>{task.status?.toUpperCase() ?? '未知'}</span></td>
                <td style={{ fontSize: '12px', color: task.status === 'running' ? 'var(--info)' : 'var(--text-secondary)' }}>{duration}</td>
                <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{(task.retryCount ?? 0) > 0 ? task.retryCount : '-'}</td>
                <td style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                  {sessionId ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span title={sessionId}>{shortSession}</span>
                      <button 
                        class="action-btn" 
                        style={{ padding: '2px 4px', fontSize: '10px' }}
                        onclick={`navigator.clipboard.writeText('${copyCmd}').then(() => alert('已复制: ${copyCmd}'))`}
                        title="复制命令"
                      >📋</button>
                    </span>
                  ) : '-'}
                </td>
                <td>
                  <button class="action-btn" onclick={`showDetail(${task.id})`}>详情</button>
                  {task.status === 'failed' && (
                    <button class="action-btn btn-retry" onclick={`retryTask(${task.id})`}>重试</button>
                  )}
                  <button class="action-btn btn-delete" onclick={`deleteTask(${task.id})`}>删除</button>
                </td>
              </tr>
            )})}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'center', gap: '10px', alignItems: 'center' }}>
        {page > 1 && (
          <a href={`/?page=${page - 1}`} class="refresh-btn" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)' }}>← 上一页</a>
        )}
        <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>第 {page} 页 / 共 {Math.ceil(counts.total / limit)} 页</span>
        {(page * limit) < counts.total && (
          <a href={`/?page=${page + 1}`} class="refresh-btn" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)' }}>下一页 →</a>
        )}
      </div>

      <dialog id="detail-dialog">
        <div class="dialog-header">
          <h3 style={{ margin: 0 }}>任务详情</h3>
          <button class="close-btn" onclick="document.getElementById('detail-dialog').close()">×</button>
        </div>
        <div class="dialog-body">
          <pre id="dialog-content"></pre>
        </div>
      </dialog>
    </Layout>
  );
});

app.get('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const task = await TaskService.getById(Number(id));
  return c.json(task);
});

app.post('/api/tasks/:id/retry', async (c) => {
  const id = c.req.param('id');
  await TaskService.retry(Number(id));
  return c.json({ success: true });
});

app.delete('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  await TaskService.delete(Number(id));
  return c.json({ success: true });
});

export default {
  port: 3000,
  fetch: app.fetch,
};

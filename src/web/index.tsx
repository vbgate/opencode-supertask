import { Hono } from 'hono';
import { html } from 'hono/html';
import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { desc, sql, eq } from 'drizzle-orm';
import { db, schema } from '@core/db';
import { loadConfig, validateConfig, CONFIG_PATH, type GatewayConfig } from '@gateway/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import type { TaskStatus } from '@core/db/schema';
import { getGatewayHealth } from '@gateway/health';

const app = new Hono();
const TASK_STATUSES = new Set<TaskStatus>([
    'pending', 'running', 'done', 'failed', 'dead_letter', 'cancelled',
]);

function parsePositiveInteger(value: string): number | null {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTaskStatus(value: string): TaskStatus | null {
    return TASK_STATUSES.has(value as TaskStatus) ? value as TaskStatus : null;
}

function safeStatus(value: string | null): TaskStatus | 'unknown' {
    return value && TASK_STATUSES.has(value as TaskStatus) ? value as TaskStatus : 'unknown';
}

app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
});

app.use('/api/*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();

    const fetchSite = c.req.header('Sec-Fetch-Site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
        return c.json({ error: 'cross-site request rejected' }, 403);
    }

    const origin = c.req.header('Origin');
    if (origin) {
        try {
            const originUrl = new URL(origin);
            const requestUrl = new URL(c.req.url);
            const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname);
            if (!loopback || originUrl.origin !== requestUrl.origin) {
                return c.json({ error: 'cross-site request rejected' }, 403);
            }
        } catch {
            return c.json({ error: 'invalid origin' }, 403);
        }
    }

    return next();
});

app.get('/health', (c) => {
    const health = getGatewayHealth();
    return c.json(health, health.status === 'ok' ? 200 : 503);
});

function formatDuration(startAt: Date | null, endAt: Date | null): string {
    if (!startAt) return '-';
    const start = new Date(startAt).getTime();
    const end = endAt ? new Date(endAt).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    if (seconds < 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function timeAgo(ms: number | null): string {
    if (!ms) return '-';
    const diff = Date.now() - ms;
    if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return `${Math.floor(diff / 86400000)}天前`;
}

function timeUntil(ms: number | null): string {
    if (!ms) return '-';
    const diff = ms - Date.now();
    if (diff < 0) return '已到期';
    if (diff < 60000) return `${Math.floor(diff / 1000)}秒后`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟后`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时后`;
    return `${Math.floor(diff / 86400000)}天后`;
}

function formatDate(ts: Date | number | null): string {
    if (!ts) return '-';
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function esc(s: string | null | undefined): string {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readCurrentConfig(): Record<string, unknown> {
    if (!existsSync(CONFIG_PATH)) return {};
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch { return {}; }
}

function writeConfig(cfg: GatewayConfig): void {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    renameSync(tempPath, CONFIG_PATH);
}

const SHARED_STYLES = html`
<style>
  :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --t1:#c9d1d9; --t2:#8b949e; --green:#238636; --red:#da3633; --yellow:#d29922; --blue:#1f6feb; --purple:#8957e5; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; background:var(--bg); color:var(--t1); margin:0; line-height:1.5; }
  .c { max-width:1280px; margin:0 auto; padding:20px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid var(--border); padding-bottom:16px; }
  h1 { font-size:22px; margin:0; color:#fff; }
  nav.tabs { display:flex; gap:0; margin-bottom:20px; border-bottom:1px solid var(--border); }
  nav.tabs a { display:block; padding:10px 20px; color:var(--t2); text-decoration:none; font-size:14px; font-weight:500; border-bottom:2px solid transparent; }
  nav.tabs a:hover { color:var(--t1); }
  nav.tabs a.active { color:#fff; border-bottom-color:var(--blue); }
  .g4 { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:16px; margin-bottom:24px; }
  .g3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px; }
  .sv { font-size:28px; font-weight:bold; }
  .sl { color:var(--t2); font-size:12px; text-transform:uppercase; margin-top:4px; }
  .panel { background:var(--card); border:1px solid var(--border); border-radius:8px; overflow:hidden; margin-bottom:16px; }
  .ph { padding:12px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
  .ph h3 { margin:0; font-size:14px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:#21262d; color:var(--t2); font-weight:600; text-align:left; padding:8px 12px; white-space:nowrap; }
  td { padding:8px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  tr:hover { background:rgba(255,255,255,0.02); }
  .badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; }
  .b-pending { background:rgba(110,118,129,0.3); color:#8b949e; }
  .b-running { background:rgba(56,139,253,0.15); color:#58a6ff; }
  .b-done { background:rgba(46,160,67,0.15); color:#3fb950; }
  .b-failed { background:rgba(248,81,73,0.15); color:#f85149; }
  .b-dead_letter { background:rgba(210,153,34,0.15); color:#d29922; }
  .b-cancelled { background:rgba(110,118,129,0.2); color:#6e7681; }
  .btn { appearance:none; background:transparent; border:1px solid var(--border); color:var(--t2); padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px; margin-right:4px; text-decoration:none; }
  .btn:hover { background:#30363d; color:#fff; }
  .btn-sm { padding:2px 6px; font-size:11px; }
  .btn-primary { background:var(--green); border-color:var(--green); color:#fff; }
  .btn-primary:hover { opacity:0.85; color:#fff; }
  .btn-danger:hover { color:var(--red); border-color:var(--red); }
  .btn-warn:hover { color:var(--yellow); border-color:var(--yellow); }
  .rf { background:var(--green); color:white; border:none; padding:6px 16px; border-radius:6px; font-weight:600; cursor:pointer; text-decoration:none; }
  .rf:hover { opacity:0.9; }
  .m { font-family:monospace; font-size:12px; }
  .mu { color:var(--t2); }
  .sm { font-size:12px; }
  .el { max-width:400px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:inline-block; vertical-align:middle; }
  .tag { display:inline-block; background:#21262d; padding:1px 6px; border-radius:4px; font-size:11px; }
  .t-cron { color:var(--purple); }
  .t-recurring { color:var(--blue); }
  .t-delayed { color:var(--yellow); }
  .pn { margin-top:16px; display:flex; justify-content:center; gap:10px; align-items:center; }
  .ir { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px; }
  .ir:last-child { border-bottom:none; }
  .ik { color:var(--t2); }
  .iv { font-weight:500; }
  .form-row { display:flex; gap:12px; align-items:center; margin-bottom:12px; }
  .form-row label { color:var(--t2); font-size:13px; min-width:100px; }
  .form-row input, .form-row select { background:#0d1117; border:1px solid var(--border); color:var(--t1); padding:6px 10px; border-radius:4px; font-size:13px; }
  .form-row input:focus, .form-row select:focus { outline:none; border-color:var(--blue); }
  .log-box { background:#0d1117; border:1px solid var(--border); border-radius:4px; padding:12px; font-family:monospace; font-size:12px; max-height:300px; overflow-y:auto; white-space:pre-wrap; color:var(--t1); margin-top:8px; }
  dialog { background:var(--card); color:var(--t1); border:1px solid var(--border); border-radius:8px; padding:0; max-width:900px; width:90%; }
  dialog::backdrop { background:rgba(0,0,0,0.6); }
  .dh { padding:16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
  .db { padding:16px; max-height:70vh; overflow-y:auto; }
  pre { margin:0; white-space:pre-wrap; font-size:12px; }
  .cb { background:transparent; border:none; color:var(--t2); cursor:pointer; font-size:20px; }
  .mt8 { margin-top:8px; }
  .mt16 { margin-top:16px; }
  .mb0 { margin-bottom:0; }
  .ta-center { text-align:center; }
  .p30 { padding:30px; }
  .toast { position:fixed; top:20px; right:20px; padding:12px 20px; border-radius:6px; color:#fff; font-size:14px; z-index:9999; display:none; }
  .toast-ok { background:var(--green); }
  .toast-err { background:var(--red); }
</style>
`;

function renderLayout(title: string, activeTab: string, body: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} - SuperTask</title>${SHARED_STYLES}
<script>
async function retryTask(id){if(!confirm('确定重试任务 #'+id+'?'))return;await fetch('/api/tasks/'+id+'/retry',{method:'POST'});location.reload();}
async function deleteTask(id){if(!confirm('确定删除任务 #'+id+'?'))return;await fetch('/api/tasks/'+id,{method:'DELETE'});location.reload();}
async function showDetail(id){try{const r=await fetch('/api/tasks/'+id);const t=await r.json();document.getElementById('dc').textContent=JSON.stringify(t,null,2);document.getElementById('dd').showModal();}catch(e){alert('获取详情失败');}}
async function showRunDetail(id){try{const r=await fetch('/api/runs/'+id);const t=await r.json();document.getElementById('dc').textContent=JSON.stringify(t,null,2);document.getElementById('dd').showModal();}catch(e){alert('获取详情失败');}}
async function showTemplateDetail(id){try{const r=await fetch('/api/templates/'+id);const t=await r.json();document.getElementById('dc').textContent=JSON.stringify(t,null,2);document.getElementById('dd').showModal();}catch(e){alert('获取详情失败');}}
async function enableTmpl(id){await fetch('/api/templates/'+id+'/enable',{method:'POST'});location.reload();}
async function disableTmpl(id){if(!confirm('确定禁用此模板?'))return;await fetch('/api/templates/'+id+'/disable',{method:'POST'});location.reload();}
async function deleteTmpl(id){if(!confirm('确定删除此模板? 此操作不可恢复!'))return;await fetch('/api/templates/'+id,{method:'DELETE'});location.reload();}
async function triggerTmpl(id){if(!confirm('立即触发一次?'))return;const r=await fetch('/api/templates/'+id+'/trigger',{method:'POST'});const d=await r.json();if(d.success){alert('已创建任务 #'+d.taskId);location.reload();}else{alert('触发失败');}}
function toggleLog(id){const el=document.getElementById('log-'+id);el.style.display=el.style.display==='none'?'block':'none';}

async function clearDatabase(){
  if(!confirm('确定清空所有任务数据？此操作不可恢复！'))return;
  if(!confirm('再次确认：将删除所有任务、执行记录和调度模板。'))return;
  try{
    const r=await fetch('/api/database/clear',{method:'POST'});
    const d=await r.json();
    if(d.success){alert('数据库已清空');location.reload();}
    else{alert('清空失败: '+d.error);}
  }catch(e){alert('清空失败: '+e.message);}
}

async function saveConfig(){
  const form=document.getElementById('config-form');
    const data={
    worker:{
      maxConcurrency:Number(form.mc.value),
      pollIntervalMs:Number(form.pi.value),
      heartbeatIntervalMs:Number(form.hi.value)*1000,
      taskTimeoutMs:Number(form.to.value)*60000,
    },
    scheduler:{
      enabled:form.se.checked,
      checkIntervalMs:Number(form.si.value),
    },
    watchdog:{
      heartbeatTimeoutMs:Number(form.wt.value)*1000,
      checkIntervalMs:Number(form.wci.value)*1000,
      cleanupIntervalMs:Number(form.wcl.value)*3600000,
      retentionDays:Number(form.rd.value),
    }
  };
  try{
    const r=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const d=await r.json();
    if(d.success){document.getElementById('toast').textContent='配置已保存，重启 Gateway 后生效';document.getElementById('toast').style.display='block';setTimeout(()=>document.getElementById('toast').style.display='none',3000);}
    else{alert('保存失败: '+d.error);}
  }catch(e){alert('保存失败: '+e.message);}
}
</script>
</head>
<body>
<div id="toast" class="toast toast-ok"></div>
<div class="c">
  <header>
    <div><h1>SuperTask Dashboard</h1><span class="mu sm">任务调度管理中心</span></div>
    <div><a href="${activeTab === 'tasks' ? '/' : '/' + activeTab}" class="rf">刷新</a></div>
  </header>
  <nav class="tabs">
    <a href="/" class="${activeTab === 'tasks' ? 'active' : ''}">任务队列</a>
    <a href="/templates" class="${activeTab === 'templates' ? 'active' : ''}">定时任务</a>
    <a href="/runs" class="${activeTab === 'runs' ? 'active' : ''}">执行日志</a>
    <a href="/system" class="${activeTab === 'system' ? 'active' : ''}">系统状态</a>
  </nav>
  ${body}
</div>
<dialog id="dd"><div class="dh"><h3 style="margin:0">详情</h3><button class="cb" onclick="document.getElementById('dd').close()">&times;</button></div><div class="db"><pre id="dc"></pre></div></dialog>
</body></html>`;
}

app.get('/', async (c) => {
    const pageParam = c.req.query('page') || '1';
    const page = parsePositiveInteger(pageParam);
    if (page === null) return c.text('invalid page', 400);
    const statusFilter = c.req.query('status') || '';
    const parsedStatus = statusFilter ? parseTaskStatus(statusFilter) : null;
    if (statusFilter && !parsedStatus) return c.text('invalid status', 400);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [tasks, statsData] = await Promise.all([
        TaskService.list({ limit, offset, ...(parsedStatus ? { status: parsedStatus } : {}) }),
        TaskService.stats({}),
    ]);

    const taskIds = tasks.map(t => t.id);
    const latestRuns = await TaskRunService.getLatestByTaskIds(taskIds);

    const counts = {
        pending: statsData.pending || 0,
        running: statsData.running || 0,
        done: statsData.done || 0,
        failed: (statsData.failed || 0) + (statsData.dead_letter || 0),
        total: statsData.total || 0,
    };
    const totalPages = Math.ceil(counts.total / limit);

    let filterBtns = `<div style="margin-bottom:12px;display:flex;gap:6px;">
      <a href="/" class="btn ${!statusFilter ? 'btn-primary' : ''}">全部</a>
      <a href="/?status=pending" class="btn ${statusFilter === 'pending' ? 'btn-primary' : ''}">Pending</a>
      <a href="/?status=running" class="btn ${statusFilter === 'running' ? 'btn-primary' : ''}">Running</a>
      <a href="/?status=done" class="btn ${statusFilter === 'done' ? 'btn-primary' : ''}">Done</a>
      <a href="/?status=failed" class="btn ${statusFilter === 'failed' ? 'btn-primary' : ''}">Failed</a>
      <a href="/?status=dead_letter" class="btn ${statusFilter === 'dead_letter' ? 'btn-primary' : ''}">Dead Letter</a>
    </div>`;

    let rows = '';
    for (const task of tasks) {
        const status = safeStatus(task.status);
        const st = status.toUpperCase();
        rows += `<tr>
          <td class="mu">#${task.id}</td>
          <td><div style="font-weight:500">${esc(task.name)}</div><div class="mu sm el">${esc(task.prompt.substring(0, 120))}</div></td>
          <td><span class="tag">${esc(task.agent)}</span></td>
          <td><span class="badge b-${status}">${st}</span></td>
          <td class="sm ${task.status === 'running' ? '' : 'mu'}">${formatDuration(task.startedAt, task.finishedAt)}</td>
          <td class="mu sm">${(task.retryCount ?? 0) > 0 ? task.retryCount : '-'}</td>
          <td>
            <button class="btn btn-sm" onclick="showDetail(${task.id})">详情</button>
            ${(task.status === 'failed' || task.status === 'dead_letter') ? `<button class="btn btn-sm btn-warn" onclick="retryTask(${task.id})">重试</button>` : ''}
            <button class="btn btn-sm btn-danger" onclick="deleteTask(${task.id})">删除</button>
          </td></tr>`;
    }

    const qp = statusFilter ? `&status=${statusFilter}` : '';
    let paging = `<div class="pn">`;
    if (page > 1) paging += `<a href="/?page=${page - 1}${qp}" class="btn">上一页</a>`;
    paging += `<span class="mu sm">第 ${page} 页 / 共 ${totalPages} 页 (${counts.total} 条)</span>`;
    if (page < totalPages) paging += `<a href="/?page=${page + 1}${qp}" class="btn">下一页</a>`;
    paging += `</div>`;

    const body = `
      <div class="g4">
        <div class="card"><div class="sv" style="color:var(--t2)">${counts.pending}</div><div class="sl">Pending</div></div>
        <div class="card"><div class="sv" style="color:var(--blue)">${counts.running}</div><div class="sl">Running</div></div>
        <div class="card"><div class="sv" style="color:var(--green)">${counts.done}</div><div class="sl">Done</div></div>
        <div class="card"><div class="sv" style="color:var(--red)">${counts.failed}</div><div class="sl">Failed / Dead</div></div>
      </div>
      ${filterBtns}
      <div class="panel"><table>
        <thead><tr><th width="50">ID</th><th>任务</th><th>Agent</th><th width="90">状态</th><th width="70">耗时</th><th width="60">重试</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${paging}`;

    return c.html(renderLayout('任务队列', 'tasks', body));
});

app.get('/templates', async (c) => {
    const templates = await TaskTemplateService.list(100);

    const enabled = templates.filter(t => t.enabled).length;
    const disabled = templates.length - enabled;

    let rows = '';
    for (const t of templates) {
        const scheduleType = ['cron', 'recurring', 'delayed'].includes(t.scheduleType)
            ? t.scheduleType
            : 'unknown';
        const typeLabel = scheduleType === 'cron' ? 'Cron' : scheduleType === 'recurring' ? '循环' : scheduleType === 'delayed' ? '定时' : '未知';
        const typeClass = 'tag t-' + scheduleType;
        let rule = '-';
        if (t.scheduleType === 'cron') rule = t.cronExpr || '-';
        else if (t.scheduleType === 'recurring') rule = t.intervalMs ? `${Math.floor(t.intervalMs / 60000)}分钟` : '-';
        else if (t.scheduleType === 'delayed') rule = formatDate(t.runAt);

        const statusBadge = t.enabled
            ? '<span class="badge b-done">启用</span>'
            : '<span class="badge b-cancelled">禁用</span>';
        const toggleBtn = t.enabled
            ? `<button class="btn btn-sm btn-warn" onclick="disableTmpl(${t.id})">禁用</button>`
            : `<button class="btn btn-sm" onclick="enableTmpl(${t.id})">启用</button>`;

        rows += `<tr>
          <td class="mu">#${t.id}</td>
          <td><div style="font-weight:500">${esc(t.name)}</div><div class="mu sm el">${esc(t.prompt.substring(0, 100))}</div>
            <div class="sm" style="margin-top:2px"><span class="tag">${esc(t.agent)}</span>${t.model && t.model !== 'default' ? ` <span class="tag">${esc(t.model)}</span>` : ''}</div></td>
          <td><span class="${typeClass}">${typeLabel}</span></td>
          <td class="m sm">${esc(rule)}</td>
          <td>${statusBadge}</td>
          <td class="sm">${t.lastRunAt ? timeAgo(t.lastRunAt) : '-'}</td>
          <td class="sm">${t.nextRunAt ? timeUntil(t.nextRunAt) : '-'}</td>
          <td>
            <button class="btn btn-sm" onclick="showTemplateDetail(${t.id})">详情</button>
            <button class="btn btn-sm btn-primary" onclick="triggerTmpl(${t.id})">触发</button>
            ${toggleBtn}
            <button class="btn btn-sm btn-danger" onclick="deleteTmpl(${t.id})">删除</button>
          </td></tr>`;
    }

    const emptyRow = templates.length === 0
        ? `<tr><td colspan="8" class="ta-center mu p30">暂无定时任务模板。使用 CLI 创建：<code>supertask template add</code></td></tr>`
        : '';

    const body = `
      <div class="g3">
        <div class="card"><div class="sv" style="color:var(--purple)">${templates.length}</div><div class="sl">模板总数</div></div>
        <div class="card"><div class="sv" style="color:var(--green)">${enabled}</div><div class="sl">已启用</div></div>
        <div class="card"><div class="sv" style="color:var(--t2)">${disabled}</div><div class="sl">已禁用</div></div>
      </div>
      <div class="panel">
        <div class="ph"><h3>调度模板</h3></div>
        <table>
          <thead><tr><th width="50">ID</th><th>名称</th><th>类型</th><th>规则</th><th width="90">状态</th><th>上次执行</th><th>下次执行</th><th>操作</th></tr></thead>
          <tbody>${rows}${emptyRow}</tbody>
        </table>
      </div>`;

    return c.html(renderLayout('定时任务', 'templates', body));
});

app.get('/runs', async (c) => {
    const page = parsePositiveInteger(c.req.query('page') || '1');
    if (page === null) return c.text('invalid page', 400);
    const limit = 50;
    const offset = (page - 1) * limit;

    const { taskRuns: tr, tasks: tk } = schema;
    const runs = await db.select({
        id: tr.id, taskId: tr.taskId, sessionId: tr.sessionId, model: tr.model,
        status: tr.status, startedAt: tr.startedAt, finishedAt: tr.finishedAt,
        log: tr.log, heartbeatAt: tr.heartbeatAt, workerPid: tr.workerPid, childPid: tr.childPid,
        taskName: tk.name, taskAgent: tk.agent,
    }).from(tr).innerJoin(tk, eq(tr.taskId, tk.id))
      .orderBy(desc(tr.startedAt), desc(tr.id)).limit(limit).offset(offset);

    const totalResult = await db.select({ count: sql<number>`count(*)` }).from(tr);
    const total = Number(totalResult[0]?.count ?? 0);
    const totalPages = Math.ceil(total / limit);

    let rows = '';
    const logsHtml: string[] = [];
    for (const run of runs) {
        const status = safeStatus(run.status);
        const shortSession = run.sessionId
            ? run.sessionId.slice(4, 7) + '***' + run.sessionId.slice(-3)
            : '-';
        const logBtn = run.log
            ? `<button class="btn btn-sm" onclick="toggleLog(${run.id})">日志</button>`
            : '';
        rows += `<tr>
          <td class="mu">#${run.id}</td>
          <td><div style="font-weight:500">${esc(run.taskName)} <span class="mu">(#${run.taskId})</span></div>
            ${run.model ? `<div class="sm"><span class="tag">${esc(run.model)}</span></div>` : ''}</td>
          <td><span class="tag">${esc(run.taskAgent)}</span></td>
          <td><span class="badge b-${status}">${status.toUpperCase()}</span></td>
          <td class="sm">${formatDuration(run.startedAt, run.finishedAt)}</td>
          <td class="sm mu">${run.heartbeatAt ? timeAgo(run.heartbeatAt) : '-'}</td>
          <td><button class="btn btn-sm" onclick="showRunDetail(${run.id})">详情</button>${logBtn}</td>
        </tr>`;

        if (run.log) {
            logsHtml.push(`<div id="log-${run.id}" style="display:none" class="mt8">
              <div class="panel"><div class="ph"><h3>Run #${run.id} 日志 — ${esc(run.taskName)}</h3></div>
              <div class="log-box">${esc(run.log)}</div></div></div>`);
        }
    }

    let paging = `<div class="pn">`;
    if (page > 1) paging += `<a href="/runs?page=${page - 1}" class="btn">上一页</a>`;
    paging += `<span class="mu sm">第 ${page} 页 / 共 ${totalPages} 页 (${total} 条)</span>`;
    if (page < totalPages) paging += `<a href="/runs?page=${page + 1}" class="btn">下一页</a>`;
    paging += `</div>`;

    const emptyRow = runs.length === 0
        ? `<tr><td colspan="7" class="ta-center mu p30">暂无执行记录</td></tr>`
        : '';

    const body = `
      <div class="g4">
        <div class="card"><div class="sv">${total}</div><div class="sl">总记录</div></div>
        <div class="card"><div class="sv" style="color:var(--green)">${runs.filter(r => r.status === 'done').length}</div><div class="sl">本页成功</div></div>
        <div class="card"><div class="sv" style="color:var(--red)">${runs.filter(r => r.status === 'failed').length}</div><div class="sl">本页失败</div></div>
        <div class="card"><div class="sv" style="color:var(--blue)">${runs.filter(r => r.status === 'running').length}</div><div class="sl">本页运行中</div></div>
      </div>
      <div class="panel"><table>
        <thead><tr><th width="50">Run</th><th>任务</th><th>Agent</th><th width="90">状态</th><th width="70">耗时</th><th>心跳</th><th>操作</th></tr></thead>
        <tbody>${rows}${emptyRow}</tbody>
      </table></div>
      ${logsHtml.join('')}
      ${paging}`;

    return c.html(renderLayout('执行日志', 'runs', body));
});

app.get('/system', async (c) => {
    const config = loadConfig();
    const stats = await TaskService.stats({});
    const runningRuns = await TaskRunService.getAllRunningRuns();
    const templates = await TaskTemplateService.list(100);
    const configExists = existsSync(CONFIG_PATH);

    let runRows = '';
    if (runningRuns.length > 0) {
        for (const run of runningRuns) {
            const shortS = run.sessionId
                ? run.sessionId.slice(4, 7) + '***' + run.sessionId.slice(-3)
                : '-';
            runRows += `<tr>
              <td class="mu">#${run.id}</td><td>#${run.taskId}</td>
              <td class="m sm">${esc(shortS)}</td>
              <td class="sm">${esc(run.model) || '-'}</td>
              <td class="sm">${formatDate(run.startedAt)}</td>
              <td class="sm">${run.heartbeatAt ? timeAgo(run.heartbeatAt) : '-'}</td>
              <td class="m sm">W:${run.workerPid ?? '-'} C:${run.childPid ?? '-'}</td>
              <td class="sm">${formatDuration(run.startedAt, null)}</td>
            </tr>`;
        }
    }

    const schedulerStatus = config.scheduler.enabled
        ? '<span class="badge b-done">已启用</span>'
        : '<span class="badge b-cancelled">已禁用</span>';
    const configFileStatus = configExists
        ? '<span class="badge b-done">是</span>'
        : '<span class="badge b-cancelled">否 (使用默认值)</span>';

    const body = `
      <form id="config-form" onsubmit="event.preventDefault();saveConfig();">
      <div class="g3">
        <div class="card">
          <h3 style="margin:0 0 12px;font-size:14px">Worker 配置</h3>
          <div class="form-row"><label>最大并发</label><input type="number" name="mc" value="${config.worker.maxConcurrency}" min="1" max="20" style="width:80px"></div>
          <div class="form-row"><label>轮询间隔(ms)</label><input type="number" name="pi" value="${config.worker.pollIntervalMs}" min="100" style="width:100px"></div>
          <div class="form-row"><label>心跳间隔(秒)</label><input type="number" name="hi" value="${config.worker.heartbeatIntervalMs / 1000}" min="5" style="width:100px"></div>
          <div class="form-row"><label>任务超时(分钟)</label><input type="number" name="to" value="${config.worker.taskTimeoutMs / 60000}" min="1" style="width:100px"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 12px;font-size:14px">Scheduler 配置</h3>
          <div class="form-row"><label>启用调度</label><input type="checkbox" name="se" ${config.scheduler.enabled ? 'checked' : ''}></div>
          <div class="form-row"><label>检查间隔(ms)</label><input type="number" name="si" value="${config.scheduler.checkIntervalMs}" min="100" style="width:100px"></div>
          <div class="ir"><span class="ik">活跃模板</span><span class="iv">${templates.filter(t => t.enabled).length} / ${templates.length}</span></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 12px;font-size:14px">Watchdog 配置</h3>
          <div class="form-row"><label>心跳超时(秒)</label><input type="number" name="wt" value="${config.watchdog.heartbeatTimeoutMs / 1000}" min="10" style="width:100px"></div>
          <div class="form-row"><label>检查间隔(秒)</label><input type="number" name="wci" value="${config.watchdog.checkIntervalMs / 1000}" min="1" style="width:100px"></div>
          <div class="form-row"><label>清理间隔(小时)</label><input type="number" name="wcl" value="${config.watchdog.cleanupIntervalMs / 3600000}" min="1" style="width:100px"></div>
          <div class="form-row"><label>数据保留(天)</label><input type="number" name="rd" value="${config.watchdog.retentionDays}" min="1" style="width:100px"></div>
        </div>
      </div>
      <div style="text-align:center;margin-bottom:24px">
        <button type="submit" class="rf" style="font-size:14px;padding:10px 30px">保存配置</button>
        <span class="mu sm" style="margin-left:12px">保存后需重启 Gateway 生效</span>
      </div>
      </form>

      <div class="panel mt8">
        <div class="ph"><h3>当前运行中的任务 (${runningRuns.length} / ${config.worker.maxConcurrency} 并发)</h3></div>
        ${runningRuns.length > 0 ? `<table>
          <thead><tr><th>Run</th><th>任务</th><th>Session</th><th>模型</th><th>启动时间</th><th>最后心跳</th><th>PID</th><th>耗时</th></tr></thead>
          <tbody>${runRows}</tbody>
        </table>` : `<div class="ta-center mu p30">当前无运行中的任务</div>`}
      </div>

      <div class="card mt16">
        <h3 style="margin:0 0 12px;font-size:14px">任务统计</h3>
        <div class="g4 mb0">
          <div><span class="mu sm">Pending:</span> <strong>${stats.pending || 0}</strong></div>
          <div><span class="mu sm">Running:</span> <strong style="color:var(--blue)">${stats.running || 0}</strong></div>
          <div><span class="mu sm">Done:</span> <strong style="color:var(--green)">${stats.done || 0}</strong></div>
          <div><span class="mu sm">Failed/Dead:</span> <strong style="color:var(--red)">${(stats.failed || 0) + (stats.dead_letter || 0)}</strong></div>
        </div>
      </div>

      <div class="card mt16">
        <h3 style="margin:0 0 12px;font-size:14px">配置文件</h3>
        <div class="ir"><span class="ik">路径</span><span class="iv m sm">${esc(CONFIG_PATH)}</span></div>
        <div class="ir"><span class="ik">文件存在</span><span class="iv">${configFileStatus}</span></div>
      </div>

      <div class="card mt16" style="border-color:var(--red)">
        <h3 style="margin:0 0 12px;font-size:14px;color:var(--red)">危险操作</h3>
        <p class="sm mu" style="margin:0 0 12px">清空所有任务数据（tasks + task_runs + task_templates），不可恢复。</p>
        <button class="btn btn-danger" style="border-color:var(--red);color:var(--red);padding:6px 16px" onclick="clearDatabase()">清空数据库</button>
      </div>`;

    return c.html(renderLayout('系统状态', 'system', body));
});

app.get('/api/tasks/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const task = await TaskService.getById(id);
    if (!task) return c.json({ error: 'not found' }, 404);
    const runs = await TaskRunService.listByTaskId(id);
    return c.json({ ...task, _runs: runs });
});

app.get('/api/runs/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const run = await TaskRunService.getById(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json(run);
});

app.get('/api/templates/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const tmpl = await TaskTemplateService.getById(id);
    if (!tmpl) return c.json({ error: 'not found' }, 404);
    return c.json(tmpl);
});

app.post('/api/tasks/:id/retry', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const task = await TaskService.retry(id);
    if (task) return c.json({ success: true });
    return await TaskService.getById(id)
        ? c.json({ error: 'task status does not allow retry' }, 409)
        : c.json({ error: 'not found' }, 404);
});

app.delete('/api/tasks/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const deleted = await TaskService.delete(id);
    return deleted ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.post('/api/templates/:id/enable', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const result = await TaskTemplateService.enable(id);
    return result ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.post('/api/templates/:id/disable', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const result = await TaskTemplateService.disable(id);
    return result ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.delete('/api/templates/:id', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const ok = await TaskTemplateService.delete(id);
    return ok ? c.json({ success: true }) : c.json({ error: 'not found' }, 404);
});

app.post('/api/templates/:id/trigger', async (c) => {
    const id = parsePositiveInteger(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid id' }, 400);
    const tmpl = await TaskTemplateService.getById(id);
    if (!tmpl) return c.json({ error: 'not found' }, 404);
    const task = await TaskService.add({
        name: `[手动触发] ${tmpl.name}`,
        agent: tmpl.agent,
        model: tmpl.model,
        prompt: tmpl.prompt,
        cwd: tmpl.cwd,
        category: tmpl.category,
        importance: tmpl.importance,
        urgency: tmpl.urgency,
        batchId: tmpl.batchId,
        maxRetries: tmpl.maxRetries,
        retryBackoffMs: tmpl.retryBackoffMs,
        timeoutMs: tmpl.timeoutMs,
        templateId: tmpl.id,
    });
    return c.json({ success: true, taskId: task.id });
});

app.put('/api/config', async (c) => {
    try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const current = readCurrentConfig();
        const curW = (current.worker ?? {}) as Record<string, unknown>;
        const curS = (current.scheduler ?? {}) as Record<string, unknown>;
        const curD = (current.watchdog ?? {}) as Record<string, unknown>;
        const bW = (body.worker ?? {}) as Record<string, unknown>;
        const bS = (body.scheduler ?? {}) as Record<string, unknown>;
        const bD = (body.watchdog ?? {}) as Record<string, unknown>;
        const merged = {
            ...current,
            ...body,
            configVersion: 2,
            worker: { ...curW, ...bW },
            scheduler: { ...curS, ...bS },
            watchdog: { ...curD, ...bD },
        };
        writeConfig(validateConfig(merged));
        return c.json({ success: true });
    } catch (err) {
        return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
});

app.post('/api/database/clear', async (c) => {
    try {
        const { tasks, taskRuns, taskTemplates } = schema;
        await db.delete(taskRuns);
        await db.delete(taskTemplates);
        await db.delete(tasks);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
});

export const dashboardApp = app;

export default {
    port: 4680,
    fetch: app.fetch,
};

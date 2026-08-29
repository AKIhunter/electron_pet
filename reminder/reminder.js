'use strict';
/* ============================================================================
 * 控制面板逻辑（reminder.js，配 reminder/reminder.html）
 * ============================================================================
 * 分区：提醒（增删）/ 通用（开机自启动开关）/ 工具与更新（培养手册、导出崩溃日志、版本栏）。
 * 数据经 preload（window.StitchPet）存主进程 userdata/。
 */
const CD = window.StitchPet;
const list = document.getElementById('list');
const form = document.getElementById('add-form');
const timeInput = document.getElementById('remind-time');
const textInput = document.getElementById('remind-text');
const manualBtn = document.getElementById('manual-btn');
const downloadBtn = document.getElementById('download-log');
const crashDot = document.getElementById('crash-dot');
const autostartToggle = document.getElementById('open-at-login');

const pad = (n) => String(n).padStart(2, '0');
// datetime-local 输入框需要 yyyy-MM-ddTHH:mm 格式
function formatLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------- 开机自启动（默认开启；设置持久化在 userdata/settings.json）
async function fillAutostart() {
  try { autostartToggle.checked = await CD.getOpenAtLogin(); }
  catch (e) { /* 失败保持默认 */ }
}
autostartToggle.addEventListener('change', async () => {
  try { await CD.setOpenAtLogin(autostartToggle.checked); }
  catch (e) { autostartToggle.checked = !autostartToggle.checked; } // 失败回滚
});

// ---------------- 崩溃日志红点 + 导出
async function refreshCrashDot() {
  try {
    const st = await CD.crashLogStatus();
    crashDot.classList.toggle('on', (st && st.count > 0));
  } catch (e) { /* 查询失败保持默认隐藏 */ }
}
downloadBtn.onclick = async () => {
  try {
    const r = await CD.downloadCrashLog();
    if (r && r.ok) {
      crashDot.classList.remove('on');
      alert(`崩溃日志已保存到：\n${r.path}`);
    } else if (r && r.reason === 'no-logs') {
      crashDot.classList.remove('on');
      alert('当前没有崩溃日志');
    } else if (r && r.reason === 'canceled') {
      /* 用户取消保存：红点保留 */
    }
  } catch (e) { /* 失败：红点保留 */ }
};

// 培养手册
manualBtn.onclick = () => CD.openManual();

// 默认时间 = 当前 + 5 分钟
const defaultTime = new Date(Date.now() + 5 * 60000);
timeInput.value = formatLocal(defaultTime);

// 显示格式：MM-DD HH:mm
function fmt(time) {
  const d = new Date(time);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 拉取提醒列表并渲染
async function render() {
  const items = await CD.listReminders();
  list.innerHTML = '';
  if (!items.length) {
    const div = document.createElement('div');
    div.id = 'empty';
    div.textContent = '还没有提醒，添加一个吧';
    list.appendChild(div);
    return;
  }
  items.forEach((r) => {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmt(r.time);
    const txt = document.createElement('span');
    txt.className = 'text';
    txt.textContent = r.text;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除';
    del.onclick = async () => { await CD.removeReminder(r.id); render(); };
    li.append(time, txt, del);
    list.appendChild(li);
  });
}

// 添加：校验时间有效且晚于当前 → 存储并刷新
form.onsubmit = async (e) => {
  e.preventDefault();
  const time = timeInput.value;
  const text = textInput.value.trim();
  if (!time || !text) return;
  const local = new Date(time);
  if (isNaN(local.getTime()) || local.getTime() <= Date.now()) {
    alert('提醒时间需晚于当前时间');
    return;
  }
  await CD.addReminder({ time, text });
  textInput.value = '';
  timeInput.value = formatLocal(new Date(Date.now() + 5 * 60000));
  render();
};

// ---------------- 版本栏 + 自动更新
const versionEl = document.getElementById('app-version');
const checkBtn = document.getElementById('check-update');
const doBtn = document.getElementById('do-update');
const statusEl = document.getElementById('update-status');

async function fillVersion() {
  try { versionEl.textContent = `当前版本 v${await CD.appVersion()}`; } catch (e) { /* 保持 v— */ }
}

checkBtn.onclick = async () => {
  checkBtn.disabled = true;
  statusEl.textContent = '正在检查…';
  doBtn.hidden = true;
  try {
    const r = await CD.updateCheck();
    if (!r.ok) {
      statusEl.textContent = r.message || '检查更新失败';
    } else if (!r.hasUpdate) {
      statusEl.textContent = `已是最新（v${r.latest}）`;
    } else {
      statusEl.textContent = `发现新版本 v${r.latest}`;
      doBtn.hidden = false;
    }
  } catch (e) {
    statusEl.textContent = '检查更新失败';
  }
  checkBtn.disabled = false;
};

doBtn.onclick = () => {
  doBtn.disabled = true;
  checkBtn.disabled = true;
  statusEl.textContent = '准备下载…';
  CD.updateInstall();
};

CD.onUpdateProgress((s) => {
  if (!s || !s.stage) return;
  if (s.stage === 'downloading') {
    statusEl.textContent = `下载中 ${s.percent || 0}%`;
  } else if (s.stage === 'installing') {
    statusEl.textContent = '正在安装更新…';
  } else if (s.stage === 'error') {
    statusEl.textContent = s.message || '更新失败';
    doBtn.disabled = false;
    checkBtn.disabled = false;
  }
});

render();
refreshCrashDot();
fillAutostart();
fillVersion();

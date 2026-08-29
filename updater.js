'use strict';
/* ============================================================================
 * 自动更新器（updater.js，主进程模块）—— NSIS 安装包覆盖式更新
 * ============================================================================
 * 流程：GitHub API 查最新 Release → 与本地版本比较 → 下载 exe 安装包
 *       （代理优先，不可用自动改直连，慢速连接 30s 熔断）→ 静默运行安装器
 *       （/S 静默 + detached 脱离应用进程树）→ app.quit() 让安装器覆盖安装。
 *       electron-builder 的 NSIS 安装器为向导式（assisted）形态；/S 静默模式
 *       仍复用注册表 InstallLocation 覆盖安装到原目录（即使自定义过安装路径），
 *       不再需要「解压 + 换壳自替换」的复杂逻辑。
 * 状态机（经 main.js 推送到控制面板）：
 *   downloading{percent} → installing / error{message}
 *
 * ★ 想改参数？config.json update 段：
 *   repoOwner / repoName   GitHub 仓库（默认 AKIhunter / electron_pet）
 *   proxyUrl               下载优先走的代理（默认 http://127.0.0.1:7890）
 * ⚠ 仅支持 NSIS 安装包形态（Release 附件 = electron_pet-v*-win-x64.exe）；
 *   开发模式（npm start）只允许「检查更新」，「安装」返回提示。
 * ⚠ 更新日志：%TEMP%\electron_pet_update.log（排障先看这里）。
 */
const { app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ------------------------------------------------------------------ 配置
const CF = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')).update || {}; }
  catch (e) { return {}; }
})();
const OWNER = CF.repoOwner || 'AKIhunter';
const REPO = CF.repoName || 'electron_pet';
const PROXY = CF.proxyUrl || 'http://127.0.0.1:7890';
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const UPDATE_LOG = path.join(os.tmpdir(), 'electron_pet_update.log');

function log(msg) {
  try { fs.appendFileSync(UPDATE_LOG, `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------------ 版本比较
// 'v1.2.3' → [1,2,3]（缺段 / 非数字按 0 处理，容错垃圾 tag）
function parseVer(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

// a 是否比 b 新（逐段数值比较）
function isNewer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// ------------------------------------------------------------------ 检查更新
// 返回 { ok, current, latest, hasUpdate, url, size }；失败 { ok:false, message }
async function checkLatest() {
  const current = app.getVersion();
  try {
    const res = await fetch(LATEST_API, { headers: { 'User-Agent': 'electron_pet-updater' } });
    if (res.status === 404) return { ok: false, message: 'GitHub 上还没有发布任何版本' };
    if (!res.ok) return { ok: false, message: `GitHub 接口返回 ${res.status}` };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    // NSIS 安装包：Release 附件里找 .exe
    const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
    if (!exe) return { ok: false, message: '最新 Release 没有找到 exe 安装包' };
    return {
      ok: true,
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      url: exe.browser_download_url,
      size: exe.size || 0,
    };
  } catch (e) {
    return { ok: false, message: `网络错误：${(e && e.message) || e}` };
  }
}

// ------------------------------------------------------------------ 下载
// curl.exe 下载（Windows 10+ 自带；windowsHide 不闪黑窗）
// --speed-limit/--speed-time：慢速熔断——直连被限速成 ~10KB/s 假连接时 30s 内中止，
// 否则要挂满 --max-time 600 才回退。
function curl(url, dest, proxy) {
  return new Promise((resolve, reject) => {
    const args = (proxy ? ['-x', proxy] : [])
      .concat(['-L', '--fail', '--connect-timeout', '15',
        '--speed-limit', '10240', '--speed-time', '30',
        '--max-time', '600', '-o', dest, url]);
    const p = spawn('curl.exe', args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', (e) => reject(new Error(`curl 启动失败：${e.message}`)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`curl 退出码 ${code}`))));
  });
}

// 策略链：先代理（本机 Clash 常驻，代理不可达时连接秒拒）→ 失败改直连（其他机器可用）
// 进度：500ms 轮询临时文件大小 ÷ Release API 给的 size
async function downloadInstaller(url, size, emit) {
  const dest = path.join(os.tmpdir(), `electron_pet_setup_${Date.now()}.exe`);
  const tryOnce = (proxy) => curl(url, dest, proxy).catch((e) => {
    try { fs.unlinkSync(dest); } catch (err) { /* 忽略 */ }
    throw e;
  });
  const timer = setInterval(() => {
    if (!size) return;
    try {
      const got = fs.statSync(dest).size;
      emit({ stage: 'downloading', percent: Math.min(100, Math.round((got / size) * 100)) });
    } catch (e) { /* 文件尚未创建 */ }
  }, 500);
  try {
    try { await tryOnce(PROXY); log(`下载完成（代理）${dest}`); }
    catch (e1) {
      log(`代理失败（${e1.message}），改走直连`);
      emit({ stage: 'downloading', percent: 0 });
      await tryOnce(null);
      log(`下载完成（直连）${dest}`);
    }
  } finally {
    clearInterval(timer);
  }
  return dest;
}

// ------------------------------------------------------------------ 运行安装器
// /S 静默安装（向导式安装器同样支持）；detached + unref 脱离应用进程树，
// 应用退出后安装器继续运行并覆盖安装（真实用户双击启动的环境无 job object，
// detached 子进程可独立存活）。
function spawnInstaller(exePath) {
  const child = spawn(exePath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

// ------------------------------------------------------------------ 安装入口（main.js 经 IPC 调用）
async function downloadAndInstall(emit) {
  if (!app || !app.isPackaged) {
    emit({ stage: 'error', message: '开发模式不支持安装更新，请到 GitHub Release 下载 exe 手动安装' });
    return;
  }
  try {
    const info = await checkLatest();
    if (!info.ok) { emit({ stage: 'error', message: info.message }); return; }
    if (!info.hasUpdate) { emit({ stage: 'error', message: '当前已是最新版本' }); return; }

    log(`更新开始 ${info.current} -> ${info.latest} ${info.url}`);
    emit({ stage: 'downloading', percent: 0 });
    const exePath = await downloadInstaller(info.url, info.size, emit);

    emit({ stage: 'installing' });
    log(`下载完成，运行安装器 ${exePath}`);
    spawnInstaller(exePath);
    log('app.quit() 调用，安装器将覆盖安装');
    app.quit();
  } catch (e) {
    const message = (e && e.message) || String(e);
    log(`ERROR ${message}`);
    emit({ stage: 'error', message });
  }
}

module.exports = { checkLatest, downloadAndInstall };

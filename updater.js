'use strict';
/* ============================================================================
 * 自动更新器（updater.js，主进程模块）
 * ============================================================================
 * 流程：GitHub API 查最新 Release → 与本地版本比较 → 下载 zip（代理优先，
 *       不可用自动改直连，慢速连接 30s 熔断）→ 解压校验 → 生成 update.ps1
 *       换壳（等旧进程退出 → 目录整体替换 → 拉起新版 → 清理旧目录）→ app.quit()。
 * 状态机（经 main.js 推送到控制面板）：
 *   downloading{percent} → extracting → restarting / error{message}
 *
 * ★ 想改参数？config.json update 段：
 *   repoOwner / repoName   GitHub 仓库（默认 AKIhunter / electron_pet）
 *   proxyUrl               下载优先走的代理（默认 http://127.0.0.1:7890，不可用自动直连）
 *   exeName                便携版主程序名（默认 electron_pet.exe，解压校验用）
 * ⚠ 仅支持便携 zip 形态（Release 附件 = electron-builder zip 产物）；
 *   开发模式（npm start）只允许「检查更新」，「安装」返回提示。
 * ⚠ 换壳脚本日志：%TEMP%\electron_pet_update.log（排障先看这里）。
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
const EXE_NAME = CF.exeName || 'electron_pet.exe';
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const UPDATE_LOG = path.join(os.tmpdir(), 'electron_pet_update.log');

function log(msg) {
  try { fs.appendFileSync(UPDATE_LOG, `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* 忽略 */ }
}
process.on('exit', () => log('process exit'));

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
    const zip = (rel.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
    if (!zip) return { ok: false, message: '最新 Release 没有找到 zip 附件' };
    return {
      ok: true,
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      url: zip.browser_download_url,
      size: zip.size || 0,
    };
  } catch (e) {
    return { ok: false, message: `网络错误：${(e && e.message) || e}` };
  }
}

// ------------------------------------------------------------------ 下载
// curl.exe 下载（Windows 10+ 自带；windowsHide 不闪黑窗）
// --speed-limit/--speed-time：慢速熔断——直连被限速成 ~10KB/s 假连接时 30s 内中止，
// 否则要挂满 --max-time 600 才回退（实测病灶）。
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
async function downloadZip(url, size, emit) {
  const dest = path.join(os.tmpdir(), `electron_pet_update_${Date.now()}.zip`);
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

// ------------------------------------------------------------------ 解压 + 校验
function runPs(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'].concat(args),
      { windowsHide: true, stdio: 'ignore' });
    p.on('error', (e) => reject(new Error(`PowerShell 启动失败：${e.message}`)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`PowerShell 退出码 ${code}`))));
  });
}

async function extractZip(zipPath, staging) {
  fs.mkdirSync(staging, { recursive: true });
  const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
  await runPs(['-Command',
    `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(staging)} -Force`]);
}

// 校验解压结果：zip 根或其唯一一级目录须含 EXE_NAME；返回新版本的目录
function validateStaging(staging) {
  if (fs.existsSync(path.join(staging, EXE_NAME))) return staging;
  const dirs = fs.existsSync(staging)
    ? fs.readdirSync(staging, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  if (dirs.length === 1 && fs.existsSync(path.join(staging, dirs[0], EXE_NAME))) {
    return path.join(staging, dirs[0]);
  }
  throw new Error(`更新包解压后没有找到 ${EXE_NAME}（包可能不完整）`);
}

// ------------------------------------------------------------------ 换壳脚本（运行时生成，不打包、不受 asar 限制）
// ⚠ 参数经环境变量传入而非命令行：实测 powershell.exe -File <脚本> -Param 值 形态
//   会静默退出（exit -1，脚本一行都不执行）；-File 裸调用（office-watch.ps1 同形态）稳定，
//   故脚本内从 $env: 读取参数。
function buildUpdatePs1() {
  return `
$log = Join-Path $env:TEMP 'electron_pet_update.log'
function L([string]$m) { try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [ps1] $m" } catch {} }
$TargetPid = [int]$env:PET_UPDATE_TARGET_PID
$AppDir = $env:PET_UPDATE_APP_DIR
$SrcDir = $env:PET_UPDATE_SRC_DIR
$ExeRel = $env:PET_UPDATE_EXE_REL
try {
  if ($TargetPid -gt 0) { Wait-Process -Id $TargetPid -Timeout 30 -ErrorAction SilentlyContinue }
  L "old pid $TargetPid exited"
  if (Test-Path "$AppDir.old") { Remove-Item "$AppDir.old" -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $AppDir -Destination "$AppDir.old" -Force
  L "moved old -> $AppDir.old"
  Move-Item -LiteralPath $SrcDir -Destination $AppDir -Force
  L "new in place -> $AppDir"
  Start-Process -FilePath (Join-Path $AppDir $ExeRel)
  L "restarted new version"
  Start-Sleep -Seconds 3
  for ($i = 1; $i -le 3; $i++) {
    try { Remove-Item "$AppDir.old" -Recurse -Force -ErrorAction Stop; L "cleaned .old"; break }
    catch { L "clean retry $i"; Start-Sleep -Seconds 2 }
  }
} catch {
  L ("ERROR " + $_.Exception.Message)
}
`.trim();
}

// ------------------------------------------------------------------ 安装入口（main.js 经 IPC 调用）
async function downloadAndInstall(emit) {
  if (!app.isPackaged) {
    emit({ stage: 'error', message: '开发模式不支持安装更新，请到 GitHub Release 下载 zip 手动替换' });
    return;
  }
  try {
    const info = await checkLatest();
    if (!info.ok) { emit({ stage: 'error', message: info.message }); return; }
    if (!info.hasUpdate) { emit({ stage: 'error', message: '当前已是最新版本' }); return; }

    // 便携目录自替换：装在系统区（Program Files）无写权限 → 拒绝，引导手动更新
    const appDir = path.dirname(process.execPath);
    const exeRel = path.basename(process.execPath);
    if (/^c:\\program files/i.test(appDir)) {
      emit({ stage: 'error', message: `安装在系统目录（${appDir}），请手动下载更新` });
      return;
    }

    log(`更新开始 ${info.current} -> ${info.latest} ${info.url}`);
    emit({ stage: 'downloading', percent: 0 });
    const zipPath = await downloadZip(info.url, info.size, emit);

    emit({ stage: 'extracting' });
    const staging = path.join(os.tmpdir(), `electron_pet_staging_${Date.now()}`);
    await extractZip(zipPath, staging);
    const srcDir = validateStaging(staging);
    try { fs.unlinkSync(zipPath); } catch (e) { /* 忽略 */ }

    emit({ stage: 'restarting' });
    const ps1 = path.join(os.tmpdir(), `electron_pet_update_${Date.now()}.ps1`);
    fs.writeFileSync(ps1, buildUpdatePs1(), 'utf-8');
    log(`spawn update.ps1 pid=${process.pid} appDir=${appDir} src=${srcDir} exe=${exeRel}`);
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ps1,
    ], {
      // ⚠ 不用 detached + stdio 全 ignore：实测该组合在受限环境下子进程随父进程
      //   退出被杀；v6 形态（无 detached + 半开管）实测换壳成功
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PET_UPDATE_TARGET_PID: String(process.pid),
        PET_UPDATE_APP_DIR: appDir,
        PET_UPDATE_SRC_DIR: srcDir,
        PET_UPDATE_EXE_REL: exeRel,
      },
    });
    child.unref(); // 独立于本进程存活：等退出 → 换壳 → 拉起新版
    child.once('exit', (code) => log(`update.ps1 exited code=${code}`));
    log('app.quit() 调用');
    app.quit();
  } catch (e) {
    const message = (e && e.message) || String(e);
    log(`ERROR ${message}`);
    emit({ stage: 'error', message });
  }
}

module.exports = { checkLatest, downloadAndInstall, buildUpdatePs1 };

'use strict';
/* ============================================================================
 * 自动更新器（updater.js，主进程模块）
 * ============================================================================
 * 流程：GitHub API 查最新 Release → 与本地版本比较 → 下载 zip（代理优先，
 *       不可用自动改直连，慢速连接 30s 熔断）→ 解压到应用目录旁的同卷暂存目录
 *       （换壳两步 Move-Item 均为瞬时重命名；跨盘目录交换会退化成 122MB 慢速
 *       复制，曾在真实链路中卡死）→ 生成 update.ps1 换壳脚本（参数内联）→
 *       spawn 并等其写「就绪标记」→ app.quit()。
 *       换壳脚本：预先站在 Wait-Process 上，旧进程一退出立刻同卷两步重命名
 *       （失败自动回滚）→ 拉起新版 → 清理旧目录；被中断时由新版启动期
 *       cleanupAfterUpdate 兜底清理。
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
// ★ 参数直接内联进脚本字面量（脚本每次更新都重新生成，无需 param/env 传递——
//   实测 powershell.exe -File 带参数会静默退出；环境变量在跨进程链路上不可靠）
// ★ 第一件事写「就绪标记」：应用轮询到该文件才 app.quit()，确保脚本已完成
//   PowerShell 启动并站在 Wait-Process 上——旧进程一退出（0ms 起）立刻执行
//   两步同卷重命名，几十毫秒内完成关键交换，不给任何收割者可乘之机。
function buildUpdatePs1(appDir, srcDir, stagingRoot, exeRel, targetPid, readyMark) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `
$log = Join-Path $env:TEMP 'electron_pet_update.log'
function L([string]$m) { try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [ps1] $m" } catch {} }
$TargetPid = ${parseInt(targetPid, 10) || 0}
$AppDir = ${q(appDir)}
$SrcDir = ${q(srcDir)}
$StagingRoot = ${q(stagingRoot)}
$ExeRel = ${q(exeRel)}
$ReadyMark = ${q(readyMark || '')}
try { Set-Content -Path $ReadyMark -Value 'ready' } catch {}
L "ps1 start pid=$PID old=$TargetPid app=$AppDir src=$SrcDir"
try {
  if ($TargetPid -gt 0) { Wait-Process -Id $TargetPid -Timeout 30 -ErrorAction SilentlyContinue }
  L "old pid $TargetPid exited"
  if (Test-Path "$AppDir.old") { Remove-Item "$AppDir.old" -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $AppDir -Destination "$AppDir.old" -Force
  L "moved old -> $AppDir.old"
  try {
    Move-Item -LiteralPath $SrcDir -Destination $AppDir -Force
    L "new in place -> $AppDir"
  } catch {
    L ("ERROR new move failed: " + $_.Exception.Message)
    try { Move-Item -LiteralPath "$AppDir.old" -Destination $AppDir -Force; L "restored old -> $AppDir" }
    catch { L ("ERROR restore failed: " + $_.Exception.Message) }
    exit 1
  }
  if ($StagingRoot -and ($StagingRoot -ne $SrcDir) -and (Test-Path $StagingRoot)) {
    Remove-Item $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Start-Process -FilePath (Join-Path $AppDir $ExeRel)
  L "restarted new version"
  Start-Sleep -Seconds 3
  for ($i = 1; $i -le 3; $i++) {
    try { Remove-Item "$AppDir.old" -Recurse -Force -ErrorAction Stop; L "cleaned .old"; break }
    catch { L "clean retry $i"; Start-Sleep -Seconds 2 }
  }
  if ($ReadyMark) { Remove-Item $ReadyMark -Force -ErrorAction SilentlyContinue }
} catch {
  L ("ERROR " + $_.Exception.Message)
}
`.trim();
}

// spawn 换壳脚本：无 detached + 半开管（stdio ['ignore','pipe','pipe']）+ unref。
// ⚠ stdio 不能用 'ignore'：v1.0.2 发布前实测（electron_pet_update.log 2026-08-29 23:37
//   一轮）Electron 主进程退出后 powershell 子进程随即被杀、换壳中断；而半开管形态
//   （同日志 22:24 一轮）子进程在应用退出后仍继续执行并完成目录替换。机制与
//   Windows 进程/句柄继承相关，勿凭 node 环境测试结论改回（node 父进程两种形态都存活）。
// cwd 设为 tmpdir：子进程工作目录不能落在即将被改名的应用目录里。
function spawnUpdateScript(ps1) {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
  child.unref();
  return child;
}

// ------------------------------------------------------------------ 安装入口（main.js 经 IPC 调用）
async function downloadAndInstall(emit) {
  if (!app || !app.isPackaged) {
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

    // 同卷暂存目录（应用目录旁）：换壳两步 Move-Item 均为瞬时重命名；
    // 顺带清掉上次中断遗留的 .pet_update_* 残留
    const appDirParent = path.dirname(appDir);
    const staging = path.join(appDirParent, `.pet_update_${Date.now()}`);
    try {
      for (const d of fs.readdirSync(appDirParent)) {
        if (/^\.pet_update_/.test(d)) {
          fs.rmSync(path.join(appDirParent, d), { recursive: true, force: true });
        }
      }
    } catch (e) { /* 忽略 */ }
    try { fs.mkdirSync(staging, { recursive: true }); }
    catch (e) {
      log(`暂存目录创建失败 ${e.message}`);
      emit({ stage: 'error', message: `无法在应用目录旁创建更新暂存目录，请手动下载更新` });
      return;
    }

    log(`更新开始 ${info.current} -> ${info.latest} ${info.url}`);
    emit({ stage: 'downloading', percent: 0 });
    const zipPath = await downloadZip(info.url, info.size, emit);

    emit({ stage: 'extracting' });
    await extractZip(zipPath, staging);
    const srcDir = validateStaging(staging);
    try { fs.unlinkSync(zipPath); } catch (e) { /* 忽略 */ }

    emit({ stage: 'restarting' });
    const readyMark = path.join(os.tmpdir(), `electron_pet_ready_${Date.now()}.txt`);
    const ps1 = path.join(os.tmpdir(), `electron_pet_update_${Date.now()}.ps1`);
    fs.writeFileSync(ps1, buildUpdatePs1(appDir, srcDir, staging, exeRel, process.pid, readyMark), 'utf-8');
    log(`spawn ps1 appDir=${appDir} src=${srcDir} staging=${staging} exe=${exeRel} oldPid=${process.pid}`);
    const child = spawnUpdateScript(ps1);
    // 等脚本写「就绪标记」再退出：确保它已站在 Wait-Process 上（旧进程一死
    // 即刻换壳）；3s 兜底超时——脚本没就位也退出，靠脚本内 30s 等待窗口追赶。
    // spawn 失败 / 脚本秒退（-File 静默失败一类）则中止本次更新。
    const ok = await new Promise((resolve) => {
      let done = false;
      const finish = (v, why) => { if (done) return; done = true; clearInterval(poll); clearTimeout(t); log(why); resolve(v); };
      const t = setTimeout(() => finish(true, '就绪等待超时，按已交接处理'), 3000);
      const poll = setInterval(() => { if (fs.existsSync(readyMark)) finish(true, 'ps1 就绪，交接完成'); }, 40);
      child.once('error', (e) => finish(false, `ps1 启动失败 ${e.message}`));
      child.once('exit', (code) => finish(false, `ps1 提前退出 code=${code}`));
    });
    if (!ok) {
      emit({ stage: 'error', message: '更新进程启动失败，请重试或到 GitHub 手动下载' });
      return;
    }
    log('app.quit() 调用');
    app.quit();
  } catch (e) {
    const message = (e && e.message) || String(e);
    log(`ERROR ${message}`);
    emit({ stage: 'error', message });
  }
}

// ------------------------------------------------------------------ 启动期清理
// 新版首启调用（仅打包形态，无需 await）：换壳脚本被中断时兜底——
//   删 appDir.old（上轮旧版残留）+ 删 .pet_update_* 暂存残留。失败静默（重试由下轮兜）。
async function cleanupAfterUpdate(dirOverride) {
  if (!app || !app.isPackaged) return;
  const appDir = dirOverride || path.dirname(process.execPath);
  const appDirParent = path.dirname(appDir);
  for (let i = 0; i < 3; i++) {
    try {
      if (fs.existsSync(`${appDir}.old`)) {
        fs.rmSync(`${appDir}.old`, { recursive: true, force: true });
        log(`启动清理：已删除 ${appDir}.old`);
      }
      break;
    } catch (e) { await new Promise((r) => setTimeout(r, 600)); } // 旧进程尚未退干净，稍候重试
  }
  try {
    for (const d of fs.readdirSync(appDirParent)) {
      if (/^\.pet_update_/.test(d)) {
        fs.rmSync(path.join(appDirParent, d), { recursive: true, force: true });
        log(`启动清理：已删除暂存残留 ${d}`);
      }
    }
  } catch (e) { /* 忽略 */ }
}

module.exports = { checkLatest, downloadAndInstall, buildUpdatePs1, spawnUpdateScript, cleanupAfterUpdate };

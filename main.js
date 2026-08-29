'use strict';
/* ============================================================================
 * 史迪奇桌面宠物 —— 主进程
 * ============================================================================
 * 职责：宠物透明窗口 / 托盘 / 提醒面板的创建与管理、IPC 注册，
 *       以及三类需要 OS 级能力的交互：
 *         ① 拖拽跟随（绝对定位 + 16ms 定时器 + 全屏事件盾）
 *         ② 跑开位移（光标监测 + flee.js 位移数学）
 *         ③ 办公前台监视（office-watch.ps1 子进程）
 *
 * ★ 想改参数？速查（详见 README「参数修改速查表」）：
 *   config.json               displayScale / frameCanvas / interaction(跑开) / office / tray / update(自动更新)
 *   createPetWindow()  下方    初始位置边距（右 60px、下 40px）
 *   CHECK_INTERVAL     下方    提醒检查间隔
 *   registerIpc()      内部    拖拽跟随节拍 16ms
 *   renderer/pet.js           动作帧率 / 优先级 / 冷却 / 拖拽阈值（BEHAVIORS 等）
 *   flee.js                  跑开收边余量 / 有效位移阈值
 *   ⚠ 任何文件改动后需重启应用才生效
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, Notification, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater.js'); // 自动更新：版本检查 / 下载换壳重启（详见该文件头注释）

// userData：开发模式指向项目内目录（沙盒/受限环境无法写 %APPDATA%，本地化便于排查）；
// 打包模式用系统默认 %APPDATA%——便携目录会在升级换壳时被整体替换，用户数据不能放里面
if (!app.isPackaged) app.setPath('userData', path.join(__dirname, 'userdata'));

// ------------------------------------------------------------------ 配置（config.json）
// 主进程实际消费的字段：displayScale / frameCanvas / interaction(跑开) / office / tray
// ⚠ config.json 的 behaviors / cooldowns / dragThreshold 为参考值，
//   实际生效位置在 renderer/pet.js 的 BEHAVIORS / COOLDOWN / INTERACTION
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
} catch (e) {
  console.error('config 解析失败', e);
}

const CF = {
  displayScale: config.displayScale || 2,  // 显示倍率（兜底 2）：窗口边长 = frameCanvas × 此值
  frameCanvas: config.frameCanvas || 256,  // 帧画布边长 px（兜底 256，须与 assets 帧实际尺寸一致）
  interaction: config.interaction || {},
  cooldowns: config.cooldowns || {},
  office: config.office || {},
};

// ------------------------------------------------------------------ assets meta
let assetsMeta = { actions: {} };
try {
  assetsMeta = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'meta.json'), 'utf-8'));
} catch (e) {
  console.error('assets/meta.json 读取失败', e);
}

let petWindow = null;
let reminderWindow = null;
let tray = null;
let reminderManager = null;

// 拖拽调试日志（直写文件，不受 stdout 重定向句柄失效影响）
const TRACE_FILE = path.join(__dirname, 'verify', 'drag_trace.log');
function trace(msg) {
  try { fs.appendFileSync(TRACE_FILE, `${Date.now()} ${msg}\n`); } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------------ 崩溃日志（问题 8）
// 三类来源：主进程未捕获异常/未处理 Promise 拒绝、各窗口渲染进程崩溃（render-process-gone）。
// 同步写 userdata/crash/crash-YYYYMMDD.log（JSONL）+ pending.json（未下载标记，驱动红点与启动气泡）。
// ★ 主进程崩溃后不退出（桌宠记录后尽力自愈）；渲染崩溃由 attachRenderGone 自动 reload 复活。
const CRASH_DIR = path.join(app.getPath('userData'), 'crash');
const PENDING_FILE = path.join(CRASH_DIR, 'pending.json');

function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')); } catch (e) { return { count: 0 }; }
}

function writeCrash(scope, info) {
  try {
    fs.mkdirSync(CRASH_DIR, { recursive: true });
    const err = info instanceof Error ? info : new Error(String(info && info.message ? info.message : info));
    const line = { ts: new Date().toISOString(), scope, message: err.message, stack: err.stack || '' };
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    fs.appendFileSync(path.join(CRASH_DIR, `crash-${day}.log`), JSON.stringify(line) + '\n');
    const p = readPending();
    fs.writeFileSync(PENDING_FILE, JSON.stringify({ count: (p.count || 0) + 1, since: p.since || Date.now(), lastAt: Date.now() }, null, 2));
    console.error(`[crash] ${scope}: ${err.message}`);
    trace(`crash ${scope}: ${err.message}`);
  } catch (e) { console.error('崩溃日志写入失败', e); }
}

process.on('uncaughtException', (err) => writeCrash('main-uncaught', err));
process.on('unhandledRejection', (reason) => writeCrash('main-rejection', reason));

// 渲染进程崩溃：记录 + 自动 reload 复活（宠物窗口空白=宠物"消失"的问题 1 主修复）
function attachRenderGone(win, scope) {
  win.webContents.on('render-process-gone', (_e, details) => {
    writeCrash(scope, new Error(`${details.reason} exitCode=${details.exitCode}`));
    try { win.webContents.reload(); } catch (e) { /* 忽略 */ }
  });
}

// 下次启动时若存在未下载的崩溃记录 → 宠物头上弹气泡提示（时长 12s）
function notifyPendingCrash() {
  try {
    if (readPending().count > 0 && petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('remind', { text: '将日志信息下载下来，提供给代旭秋', ms: 12000 });
    }
  } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------------ 提醒管理器
// 提醒数据持久化在 userdata/reminders.json；到期后系统通知 + 宠物气泡，触发即删除（一次性）
const REMINDER_FILE = () => path.join(app.getPath('userData'), 'reminders.json');
const CHECK_INTERVAL = 1000; // ★ 提醒到期检查间隔 ms（越小触发越准时，CPU 占用略增）

class ReminderManager {
  constructor() {
    this.timer = null;
    this.reminders = this._load();
    this.scheduled = new Set(); // id 集合，已触发的这次打开内不再重复
  }
  _load() {
    try {
      return JSON.parse(fs.readFileSync(REMINDER_FILE(), 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(REMINDER_FILE()), { recursive: true });
      fs.writeFileSync(REMINDER_FILE(), JSON.stringify(this.reminders, null, 2), 'utf-8');
    } catch (e) {
      console.error('提醒保存失败', e);
    }
  }
  list() { return this.reminders; }
  add({ time, text }) {
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time, text, created: Date.now() };
    this.reminders.unshift(item);
    this._save();
    return item;
  }
  remove(id) {
    this.reminders = this.reminders.filter((r) => r.id !== id);
    this._save();
    return true;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), CHECK_INTERVAL);
    this._tick();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  _tick() {
    const now = Date.now();
    for (const r of this.reminders) {
      const due = new Date(r.time).getTime();
      if (!isNaN(due) && due > 0 && due <= now && !this.scheduled.has(r.id)) {
        this.scheduled.add(r.id);
        this._fire(r);
      }
    }
  }
  _fire(r) {
    // 系统原生通知
    if (Notification.isSupported()) {
      try {
        new Notification({ title: CF.tray?.tooltip || '史迪奇提醒', body: r.text }).show();
      } catch (e) { /* 忽略 */ }
    }
    // 宠物窗口气泡
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('remind', { text: r.text, time: r.time });
    }
    this.remove(r.id); // 触发后移除该条（一次性提醒）
  }
}

// ------------------------------------------------------------------ 宠物窗口
function createPetWindow() {
  const winSize = CF.frameCanvas * CF.displayScale; // ★ 宠物窗口边长（正方形）= 画布 × 倍率
  petWindow = new BrowserWindow({
    width: winSize,
    height: winSize,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      transparent: true,
      // ★ 关键：透明置顶窗口在 Windows 上会被 Chromium 遮挡追踪误判为"隐藏页"，
      //   document.visibilityState=hidden → 帧动画 setInterval 被节流到 ~1Hz（动画卡成幻灯片）。
      //   关闭后台节流后动画按 frameIntervalMs 全速播放。
      backgroundThrottling: false,
    },
  });
  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  attachRenderGone(petWindow, 'renderer-pet'); // 渲染崩溃 → 记录 + 自动 reload 复活

  // 初始位置：主屏右下角（★ 60 / 40 分别为右、下边距 px，可自行调整）
  const area = screen.getPrimaryDisplay().workArea;
  petWindow.setPosition(area.x + area.width - winSize - 60, area.y + area.height - winSize - 40);
  return petWindow;
}

function showPet() { if (petWindow) petWindow.show(); }
function hidePet() { if (petWindow) petWindow.hide(); }
function togglePet() { if (petWindow) { petWindow.isVisible() ? hidePet() : showPet(); } }

// ------------------------------------------------------------------ 托盘
const TRAY_ICON_SIZE = 64; // ★ 托盘图标尺寸 px（内容裁剪透明边后撑满，系统自动适配槽位）

// 取待机第 1 帧 → 裁掉四周透明边（角色原本仅占画布 ~72%，是"看不清"的主因）→ 整图缩放
function buildTrayIcon() {
  const base = path.join(__dirname, 'assets', 'idle1', 'frame_00001.png');
  if (fs.existsSync(base)) {
    const img = nativeImage.createFromPath(base);
    if (!img.isEmpty()) {
      try {
        // toBitmap() 返回原始像素（alpha 恒为每像素第 4 字节，BGRA/RGBA 通用）；兼容 Buffer / {data} 两种返回形态
        const bm = img.toBitmap();
        let data = null, width = 0, height = 0;
        if (Buffer.isBuffer(bm)) { const s = img.getSize(); width = s.width; height = s.height; data = bm; }
        else if (bm && bm.data) { width = bm.width; height = bm.height; data = bm.data; }
        if (data && data.length >= width * height * 4) {
          let x0 = width, y0 = height, x1 = -1, y1 = -1;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if (data[(y * width + x) * 4 + 3] > 10) { // alpha > 10 视为内容
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
              }
            }
          }
          if (x1 >= x0 && y1 >= y0) {
            return img.crop({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
              .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
          }
        }
      } catch (e) { console.error('托盘图标裁剪失败，退回原图', e); }
      return img.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
    }
  }
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(buildTrayIcon()); // 图标取待机第 1 帧（见上方 buildTrayIcon）
  // ★ 托盘菜单项（右键托盘弹出）：增删条目改这里，label + click 成对
  const menu = Menu.buildFromTemplate([
    { label: '培养手册', click: () => openManualWindow() },
    { label: '控制面板', click: () => openReminderWindow() },
    { label: '显示 / 隐藏宠物', click: () => togglePet() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setToolTip(CF.tray?.tooltip || '史迪奇桌面宠物');
  tray.setContextMenu(menu);
  tray.on('double-click', () => togglePet());
}

// ------------------------------------------------------------------ 培养手册（问题 5）
let manualWindow = null;
function openManualWindow() {
  if (manualWindow && !manualWindow.isDestroyed()) {
    manualWindow.show();
    manualWindow.focus();
    return;
  }
  manualWindow = new BrowserWindow({
    width: 500,  // ★ 手册窗口宽 px
    height: 640, // ★ 手册窗口高 px
    title: '培养手册',
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRenderGone(manualWindow, 'renderer-manual');
  manualWindow.loadFile(path.join(__dirname, 'renderer', 'manual.html'));
  manualWindow.on('closed', () => { manualWindow = null; });
}

// ------------------------------------------------------------------ 控制面板（原提醒面板，问题 8）
function openReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.show();
    reminderWindow.focus();
    return;
  }
  reminderWindow = new BrowserWindow({
    width: 360,  // ★ 控制面板宽 px
    height: 575, // ★ 控制面板高 px（工具栏 + 底部版本栏各一行）
    title: '控制面板',
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRenderGone(reminderWindow, 'renderer-panel');
  reminderWindow.loadFile(path.join(__dirname, 'reminder', 'reminder.html'));
  reminderWindow.on('closed', () => { reminderWindow = null; });
}

// ------------------------------------------------------------------ IPC
let dragFollower = null;
let dragShield = null;

// 拖拽事件盾：全屏透明置顶层窗口，光标在宠物窗口外松手时，
// OS 把 mouseup 投给光标下的其他窗口导致宠物收不到 pointerup（拖拽卡死、窗口一直跟鼠标）。
// 盾牌层级高于宠物窗口，保证拖拽期间的 mouseup 一定被它接收并转发 dragEnd。
// 【问题 1 修复】改为启动时预创建一次、拖拽期间 show/hide 复用：
// 旧实现每次拖拽新建/销毁全屏透明窗口，Windows 透明合成有概率出现渲染毛刺，
// 且页面监听器加载竞态会丢失 pointerup（盾牌页面未就绪时事件无人接收）。
function createDragShield() {
  if (dragShield && !dragShield.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  dragShield = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false, // 常驻隐藏，仅拖拽期间显示
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dragShield.setAlwaysOnTop(true, 'screen-saver'); // 高于宠物的 'floating'
  dragShield.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  dragShield.loadFile(path.join(__dirname, 'renderer', 'shield.html'));
}

function showDragShield() {
  if (dragShield && !dragShield.isDestroyed()) dragShield.showInactive();
}

function hideDragShield() {
  if (dragShield && !dragShield.isDestroyed()) dragShield.hide();
}

function registerIpc() {
  // ---- 拖拽开始（渲染层 pointermove 超阈值后调用）----
  // 主进程以绝对位置跟随全局光标（光标 − 固定抓取偏移）。
  // 增量方案在自移动窗口上不可靠（clientX 基准随窗口移动漂移、鼠标滑出窗口后事件丢失），
  // 绝对定位从数学上消除累计误差，16ms 固定节拍保证平滑（★ 跟随节拍改这里）。
  ipcMain.on('pet:dragStart', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (dragFollower) return;
    abortFlee(); // 用户半路抓住逃跑中的宠物
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = petWindow.getPosition();
    const offX = cursor.x - wx;
    const offY = cursor.y - wy;
    console.log(`[drag] start cursor=(${cursor.x},${cursor.y}) win=(${wx},${wy}) offset=(${offX},${offY})`);
    trace(`start cursor=(${cursor.x},${cursor.y}) win=(${wx},${wy}) offset=(${offX},${offY})`);
    showDragShield(); // 预创建的盾牌，仅显示
    dragFollower = setInterval(() => {
      if (!petWindow || petWindow.isDestroyed()) {
        clearInterval(dragFollower);
        dragFollower = null;
        hideDragShield();
        return;
      }
      const c = screen.getCursorScreenPoint();
      const tx = c.x - offX;
      const ty = c.y - offY;
      const [x, y] = petWindow.getPosition();
      if (x !== tx || y !== ty) {
        petWindow.setPosition(tx, ty);
      }
    }, 16);
  });

  // 来源可能是宠物窗口自身的 pointerup，也可能是事件盾转发的窗口外 mouseup
  ipcMain.on('pet:dragEnd', () => {
    trace('end');
    if (dragFollower) { clearInterval(dragFollower); dragFollower = null; }
    hideDragShield();
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('drag-end');
  });

  // 右键事件（由 renderer 同时触发审阅动画）-> 弹右键菜单
  ipcMain.on('pet:context-menu', () => {
    const menu = Menu.buildFromTemplate([
      { label: '培养手册', click: () => openManualWindow() },
      { label: '控制面板', click: () => openReminderWindow() },
      { label: '显示 / 隐藏宠物', click: () => togglePet() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    menu.popup({ window: petWindow });
  });

  // 培养手册（控制面板工具栏按钮触发）
  ipcMain.on('pet:manual', () => openManualWindow());

  // 动作帧元数据：各动作真实帧数，渲染层按帧数驱动序列播放
  ipcMain.handle('assets:meta', () => assetsMeta);

  // ---- 崩溃日志（问题 8）----
  ipcMain.handle('crash:status', () => ({ count: readPending().count || 0 }));

  // 合并全部崩溃日志 → 系统另存为对话框 → 写入成功清除未下载标记（日志文件保留）
  ipcMain.handle('crash:download', async (e) => {
    try {
      const files = fs.existsSync(CRASH_DIR)
        ? fs.readdirSync(CRASH_DIR).filter((f) => /^crash-\d+\.log$/.test(f)).sort()
        : [];
      if (files.length === 0) return { ok: false, reason: 'no-logs' };
      const parts = files.map((f) => `===== ${f} =====\n${fs.readFileSync(path.join(CRASH_DIR, f), 'utf-8')}`);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const win = BrowserWindow.fromWebContents(e.sender) || reminderWindow || petWindow;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `史迪奇崩溃日志-${stamp}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
      fs.writeFileSync(r.filePath, parts.join('\n\n'), 'utf-8');
      try { fs.unlinkSync(PENDING_FILE); } catch (err) { /* 忽略 */ }
      console.log(`[crash] 日志已导出 ${r.filePath}`);
      return { ok: true, path: r.filePath };
    } catch (err) {
      writeCrash('download', err);
      return { ok: false, reason: 'error' };
    }
  });

  // ---- 提醒 CRUD（控制面板调用；数据持久化在 userdata/reminders.json）----
  ipcMain.handle('reminder:list', () => reminderManager.list());
  ipcMain.handle('reminder:add', (_e, payload) => reminderManager.add(payload || {}));
  ipcMain.handle('reminder:remove', (_e, id) => reminderManager.remove(id));

  // ---- 版本与自动更新（任务 4；实现见 updater.js）----
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', () => updater.checkLatest());
  ipcMain.on('update:install', () => {
    // 安装进度状态机（downloading % / extracting / restarting / error）推送到控制面板
    updater.downloadAndInstall((state) => {
      if (reminderWindow && !reminderWindow.isDestroyed()) {
        reminderWindow.webContents.send('update:progress', state);
      }
    });
  });
}

// ------------------------------------------------------------------ 全局光标监测（窗口内快速滑动 -> 跑开）
// CDP 合成事件不移动真实光标，此主进程路径无法自动化驱动 —— 位移数学在 flee.js 离线单测覆盖。
const { computeFleeTarget, easeOutCubic, SwipeAccumulator } = require('./flee.js');

let fleeing = false;
let fleeTimer = null;
let lastFleeEnd = 0;

function abortFlee() {
  if (fleeTimer) { clearInterval(fleeTimer); fleeTimer = null; }
  fleeing = false;
}

// 跑开执行：算出目标点后以 16ms 定时器缓动移动窗口（时长 ≈ 奔跑动画一个循环）。
// ★ 距离 / 时长对应 config.json interaction.fleeDistancePx / fleeDurationMs
// 随 pet:flee 附带 { left } 方向载荷：向左跑 → 渲染层将奔跑帧水平镜像（问题 3）
function startFlee(cursor, swipe) {
  const [wx, wy] = petWindow.getPosition();
  const [w, h] = petWindow.getSize();
  const petRect = { x: wx, y: wy, width: w, height: h };
  const workArea = screen.getDisplayMatching(petRect).workArea;
  const { target } = computeFleeTarget(
    petRect, cursor, swipe, workArea, CF.interaction.fleeDistancePx || 400
  );
  const left = target.x < wx;
  console.log(`[flee] cursor=(${cursor.x},${cursor.y}) win=(${wx},${wy}) -> (${target.x},${target.y}) left=${left}`);
  trace(`flee win=(${wx},${wy}) -> (${target.x},${target.y}) left=${left}`);
  petWindow.webContents.send('pet:flee', { left });
  fleeing = true;
  const t0 = Date.now();
  const from = { x: wx, y: wy };
  const duration = CF.interaction.fleeDurationMs || 1600;
  fleeTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) { abortFlee(); return; }
    const p = Math.min(1, (Date.now() - t0) / duration);
    const e = easeOutCubic(p);
    const x = Math.round(from.x + (target.x - from.x) * e);
    const y = Math.round(from.y + (target.y - from.y) * e);
    const [cx0, cy0] = petWindow.getPosition();
    if (cx0 !== x || cy0 !== y) petWindow.setPosition(x, y);
    if (p >= 1) {
      abortFlee();
      lastFleeEnd = Date.now();
      petWindow.webContents.send('pet:flee-end');
    }
  }, 16);
}

// 快扫监测（问题 3 重写）：光标在宠物窗口内【累计】移动 ≥ swipeTravelPx 即触发（一次划动/来回均可）。
// 旧实现要求单个 40ms 采样位移 ≥60px（1500px/s），实测一次 200px 划过仅 ~53px/样本 → 需划 3 次才偶然命中。
// ★ 参数对应 config.json interaction.swipeTravelPx / swipeGapMs / fleeCooldownMs / fastMoveSampleMs
//   （swipeTravelPx 越小越灵敏；swipeGapMs 为采样间隔上限，超时清零防慢速漂移累计）
function startFleeMonitor() {
  const sample = CF.interaction.fastMoveSampleMs || 40;    // 采样间隔 ms
  const travel = CF.interaction.swipeTravelPx || 200;      // 窗内累计位移触发阈值 px
  const gap = CF.interaction.swipeGapMs || 250;            // 采样间隔超过此值清零累计 ms
  const cooldown = CF.interaction.fleeCooldownMs || 1000;  // 两次跑开最小间隔 ms
  const acc = new SwipeAccumulator(travel, gap);
  setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) { acc.reset(); return; }
    if (dragFollower || fleeing || Date.now() - lastFleeEnd < cooldown) { acc.reset(); return; }
    const now = screen.getCursorScreenPoint();
    const [wx, wy] = petWindow.getPosition();
    const size = petWindow.getSize();
    const rect = { x: wx, y: wy, width: size[0], height: size[1] };
    const swipe = acc.last
      ? { x: now.x - acc.last.x, y: now.y - acc.last.y }
      : { x: 0, y: 0 };
    if (acc.sample(now, rect, Date.now())) {
      acc.reset();
      startFlee(now, swipe);
    }
  }, sample);
}

// ------------------------------------------------------------------ 越界看门狗（问题 1 防御）
// 宠物窗口若被移出所有显示器可见区（拖拽/跑开边界情况），3 秒内拉回主屏右下角
function startBoundsWatchdog() {
  setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
    const [x, y] = petWindow.getPosition();
    const [w, h] = petWindow.getSize();
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height;
    });
    if (!visible) {
      const area = screen.getPrimaryDisplay().workArea;
      const winSize = CF.frameCanvas * CF.displayScale;
      petWindow.setPosition(area.x + area.width - winSize - 60, area.y + area.height - winSize - 40);
      trace('watchdog-restored');
      console.log('[watchdog] 宠物窗口越界，已拉回主屏右下角');
    }
  }, 3000);
}

// ------------------------------------------------------------------ 办公软件前台监视（审阅氛围）
// Electron 无跨应用前台窗口 API：持久 PowerShell 子进程输出前台进程名（变更时一行），
// 此处逐行匹配办公清单。失败时静默降级，不影响其余功能。
const { spawn } = require('child_process');
const readline = require('readline');
let officeWatcher = null;
let officeActive = false;

// ps1 路径：asar 归档内的脚本 PowerShell 读不到 → 打包时经 asarUnpack 落在 resources\app.asar.unpacked\
const OFFICE_PS1 = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'office-watch.ps1')
  : path.join(__dirname, 'office-watch.ps1');

// 启动办公前台监视。
// ★ 进程清单 / 忽略清单来自 config.json office 段：
//   processNames     触发审阅氛围的进程名（小写），想加自用软件改这里
//   ignoreForeground 前台为这些进程时不改状态（默认 electron=宠物自身）
function startOfficeWatcher() {
  if (!CF.office.enabled || CF.office.enabled !== true) return;
  const names = new Set((CF.office.processNames || []).map((s) => String(s).toLowerCase()));
  const ignore = new Set((CF.office.ignoreForeground || []).map((s) => String(s).toLowerCase()));
  if (names.size === 0) return;
  try {
    officeWatcher = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', OFFICE_PS1,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('office 监视器启动失败', e);
    return;
  }
  officeWatcher.on('error', (e) => console.error('office 监视器错误', e.message));
  officeWatcher.on('exit', (code) => console.log(`office 监视器退出 code=${code}`));
  const rl = readline.createInterface({ input: officeWatcher.stdout });
  rl.on('line', (line) => {
    const name = line.trim().toLowerCase();
    if (!name || ignore.has(name)) return; // 前台为宠物自身时不改变办公氛围
    const active = names.has(name);
    if (active !== officeActive) {
      officeActive = active;
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('office-active', active);
      }
    }
  });
}

function stopOfficeWatcher() {
  if (officeWatcher) {
    try { officeWatcher.kill(); } catch (e) { /* 忽略 */ }
    officeWatcher = null;
  }
}

// ------------------------------------------------------------------ 生命周期
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showPet());
  app.whenReady().then(() => {
    reminderManager = new ReminderManager();
    createPetWindow();
    createDragShield();     // 事件盾预创建（隐藏常驻，拖拽期间 show/hide 复用——问题 1）
    createTray();
    registerIpc();
    reminderManager.start();
    startFleeMonitor();     // 快扫 → 跑开监测
    startOfficeWatcher();   // 办公前台 → 审阅氛围
    startBoundsWatchdog();  // 越界看门狗：窗口移出所有显示器可见区 3s 内拉回（问题 1）
    setTimeout(notifyPendingCrash, 1500); // 启动 1.5s 后：存在未下载崩溃日志 → 宠物气泡提示（问题 8）
  });
  app.on('window-all-closed', () => { /* 托盘应用常驻 */ });
  app.on('before-quit', () => {
    if (reminderManager) reminderManager.stop();
    stopOfficeWatcher();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
}
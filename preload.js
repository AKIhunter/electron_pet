'use strict';
/* ============================================================================
 * 安全桥（preload.js）：渲染进程唯一入口 window.StitchPet
 * ============================================================================
 * contextIsolation 开启，渲染层无法直接访问 Node/Electron API，全部经此桥转发。
 * 命名约定：
 *   xxx()       渲染层 → 主进程（send 单向 / invoke 有返回值）
 *   onXxx(cb)   主进程 → 渲染层 推送订阅
 * 对应主进程实现见 main.js registerIpc()。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('StitchPet', {
  // ---- 查询类（invoke，有返回值）----
  getMeta: () => ipcRenderer.invoke('assets:meta'),        // 动作帧元数据（各动作真实帧数）

  // ---- 拖拽（send 单向信号；位移由主进程计算）----
  dragStart: () => ipcRenderer.send('pet:dragStart'),      // 按住拖动超阈值 → 开始跟随
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),          // 松手（含事件盾转发的窗口外松手）

  // ---- 主动作 ----
  showContextMenu: () => ipcRenderer.send('pet:context-menu'), // 右键 → 弹上下文菜单
  openManual: () => ipcRenderer.send('pet:manual'),            // 控制面板工具栏 → 打开培养手册

  // ---- 主进程推送订阅 ----
  onFlee: (cb) => ipcRenderer.on('pet:flee', (_e, payload) => cb(payload)),     // 快扫触发 → 渲染层进奔跑动画（payload.left=向左跑需镜像）
  onFleeEnd: (cb) => ipcRenderer.on('pet:flee-end', () => cb()),      // 跑开位移结束 → 回落
  onOfficeActive: (cb) => ipcRenderer.on('office-active', (_e, active) => cb(active)), // 办公前台状态变化
  onDragEnd: (cb) => ipcRenderer.on('drag-end', () => cb()),          // 主进程确认拖拽结束（幂等）
  onRemind: (cb) => ipcRenderer.on('remind', (_e, payload) => cb(payload)),           // 提醒到期/崩溃提示 → 气泡

  // ---- 提醒 CRUD（invoke，有返回值；数据在 userdata/reminders.json）----
  listReminders: () => ipcRenderer.invoke('reminder:list'),
  addReminder: (payload) => ipcRenderer.invoke('reminder:add', payload),
  removeReminder: (id) => ipcRenderer.invoke('reminder:remove', id),

  // ---- 崩溃日志（问题 8；控制面板调用）----
  crashLogStatus: () => ipcRenderer.invoke('crash:status'),      // 未下载崩溃条数（驱动红点）
  downloadCrashLog: () => ipcRenderer.invoke('crash:download'),  // 合并日志 → 另存为；成功后清除红点标记

  // ---- 版本与自动更新（任务 4；控制面板版本栏调用，实现见 updater.js）----
  appVersion: () => ipcRenderer.invoke('app:version'),           // 当前版本号
  updateCheck: () => ipcRenderer.invoke('update:check'),         // 查 GitHub 最新 Release
  updateInstall: () => ipcRenderer.send('update:install'),       // 下载 zip → 换壳 → 自动重启
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, s) => cb(s)), // 安装进度推送
});

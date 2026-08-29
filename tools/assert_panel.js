'use strict';
/* 离线断言：vm 沙箱加载 reminder/reminder.js，验证控制面板逻辑。
 * 覆盖：红点随 pending 显示、下载成功隐藏、取消保留、无日志隐藏、培养手册按钮、
 *       版本栏（版本号填充 / 检查更新 / 下载按钮 / 进度文案）。
 * 运行: node tools/assert_panel.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'reminder', 'reminder.js'), 'utf-8');

let pass = 0, fail = 0;
const assert = (cond, name) => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.error(`  [FAIL] ${name}`); }
};

// ---- stub DOM
const classList = {
  _set: new Set(),
  add(c) { this._set.add(c); },
  remove(c) { this._set.delete(c); },
  toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
  contains(c) { return this._set.has(c); },
};
const crashDot = { classList };
const manualBtn = { clicked: null, set onclick(f) { this._f = f; }, get onclick() { return this._f; } };
const downloadBtn = { set onclick(f) { this._f = f; }, get onclick() { return this._f; } };
const list = { innerHTML: '', appendChild() {} };
const form = { onsubmit: null };
const versionEl = { textContent: '当前版本 v—' };
const checkBtn = { disabled: false, set onclick(f) { this._f = f; }, get onclick() { return this._f; } };
const doBtn = { hidden: true, disabled: false, set onclick(f) { this._f = f; }, get onclick() { return this._f; } };
const statusEl = { textContent: '' };
const elements = {
  list,
  'add-form': form,
  'remind-time': { value: '' },
  'remind-text': { value: '' },
  'manual-btn': manualBtn,
  'download-log': downloadBtn,
  'crash-dot': crashDot,
  'app-version': versionEl,
  'check-update': checkBtn,
  'do-update': doBtn,
  'update-status': statusEl,
};
const document = {
  getElementById: (id) => elements[id],
  createElement: () => ({ set onclick(f) { this._f = f; }, get onclick() { return this._f; }, append() {} }),
};
let alertMsg = '';
const alerts = [];

// ---- stub CD（window.StitchPet）
const state = {
  crashCount: 1,
  downloadResult: { ok: true, path: 'D:\\log.txt' },
  openManualCalls: 0,
  version: '1.0.0',
  checkResult: { ok: true, current: '1.0.0', latest: '1.0.0', hasUpdate: false },
  installCalls: 0,
  progressCb: null,
};
const CD = {
  listReminders: () => Promise.resolve([]),
  addReminder: () => Promise.resolve({}),
  removeReminder: () => Promise.resolve(true),
  crashLogStatus: () => Promise.resolve({ count: state.crashCount }),
  downloadCrashLog: () => Promise.resolve(state.downloadResult),
  openManual: () => { state.openManualCalls++; },
  appVersion: () => Promise.resolve(state.version),
  updateCheck: () => Promise.resolve(state.checkResult),
  updateInstall: () => { state.installCalls++; },
  onUpdateProgress: (cb) => { state.progressCb = cb; },
};

const sandbox = {
  console,
  document,
  alert: (m) => { alertMsg = m; alerts.push(m); },
  Date,
  Math,
  Promise,
  window: { StitchPet: CD },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const drain = () => new Promise((r) => setImmediate(r));

(async function main() {
  await drain(); // render() + refreshCrashDot() 的微任务

  console.log('红点状态:');
  assert(crashDot.classList.contains('on'), 'pending count=1 → 红点显示');

  console.log('下载成功:');
  await downloadBtn.onclick();
  await drain();
  assert(!crashDot.classList.contains('on'), '下载成功 → 红点消失');
  assert(String(alertMsg).includes('D:\\log.txt'), `成功提示含保存路径 (${alertMsg})`);

  console.log('用户取消保存:');
  crashDot.classList.add('on'); // 重新出现 pending
  state.downloadResult = { ok: false, reason: 'canceled' };
  await downloadBtn.onclick();
  await drain();
  assert(crashDot.classList.contains('on'), '取消保存 → 红点保留');

  console.log('无日志:');
  crashDot.classList.add('on');
  state.downloadResult = { ok: false, reason: 'no-logs' };
  await downloadBtn.onclick();
  await drain();
  assert(!crashDot.classList.contains('on'), '无日志 → 红点隐藏');

  console.log('培养手册按钮:');
  manualBtn.onclick();
  assert(state.openManualCalls === 1, `点击 → openManual 恰好调用 1 次 (实际 ${state.openManualCalls})`);

  console.log('版本栏:');
  assert(versionEl.textContent === '当前版本 v1.0.0', `载入填当前版本 (${versionEl.textContent})`);
  await checkBtn.onclick();
  await drain();
  assert(statusEl.textContent === '已是最新（v1.0.0）', `无新版文案 (${statusEl.textContent})`);
  assert(doBtn.hidden === true, '无新版 → 下载按钮隐藏');
  state.checkResult = { ok: true, current: '1.0.0', latest: '1.0.1', hasUpdate: true };
  await checkBtn.onclick();
  await drain();
  assert(statusEl.textContent === '发现新版本 v1.0.1', `发现新版文案 (${statusEl.textContent})`);
  assert(doBtn.hidden === false, '有新版 → 下载按钮显示');
  doBtn.onclick();
  assert(state.installCalls === 1, '点下载 → updateInstall 恰好调用 1 次');
  assert(checkBtn.disabled === true && doBtn.disabled === true, '下载中两按钮禁用');
  state.progressCb({ stage: 'downloading', percent: 42 });
  assert(statusEl.textContent === '下载中 42%', `下载进度文案 (${statusEl.textContent})`);
  state.progressCb({ stage: 'extracting' });
  assert(statusEl.textContent === '解压中…', `解压文案 (${statusEl.textContent})`);
  state.progressCb({ stage: 'restarting' });
  assert(statusEl.textContent === '正在退出并自动更新…', `重启文案 (${statusEl.textContent})`);
  state.progressCb({ stage: 'error', message: '网络错误' });
  assert(statusEl.textContent === '网络错误', `失败文案 (${statusEl.textContent})`);
  assert(checkBtn.disabled === false && doBtn.disabled === false, '失败 → 按钮恢复可用');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

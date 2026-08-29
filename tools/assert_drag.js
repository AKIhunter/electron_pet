'use strict';
/* 离线断言：vm 沙箱加载 renderer/pet.js，模拟指针事件序列。
 * 覆盖：拖拽只发起止信号（无位移计算）、抓起定格末帧（问题 4）、单击挥手、
 *       跑开（强制打断+settle 回落+向左镜像，问题 3）、动作缩放（问题 6/7）、
 *       审阅动画 20s 冷却（右键触发/冷却期拦截/冷却结束重触发/办公氛围到期自动恢复/
 *       被打断不消耗冷却）、办公审阅氛围、drag-end 幂等、气泡时长（问题 8）。
 * 运行: node tools/assert_drag.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf-8');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.error(`  [FAIL] ${name}`); }
}

// ---- stub DOM（sprite.style 模拟 drawFrame 写入的 transform）
const sprite = { src: '', style: { transform: '' } };
const bubble = { hidden: true };
const bubbleText = { textContent: '' };
const stage = {
  listeners: {},
  addEventListener(t, f) { this.listeners[t] = f; },
  setPointerCapture() { return true; },
};
const elements = { sprite, bubble, 'bubble-text': bubbleText, stage };
const docListeners = {};
const document = {
  getElementById: (id) => elements[id],
  addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
};
let preloadCount = 0;
const intervals = [];
const timeouts = []; // 记录 setTimeout（审阅冷却恢复定时器/气泡隐藏），供手动触发
let tid = 1;
let fleeCb = null, fleeEndCb = null, officeCb = null, dragEndCb = null, remindCb = null;

const calls = { dragStart: 0, dragEnd: 0, contextMenu: 0, remind: 0 };
const CD = {
  getMeta: () => Promise.resolve({
    actions: { idle1: { frames: 37 }, idle2: { frames: 37 }, run: { frames: 30 }, wave: { frames: 13 }, drag: { frames: 5 }, review1: { frames: 63 }, review2: { frames: 37 } },
  }),
  dragStart: () => { calls.dragStart++; },
  dragEnd: () => { calls.dragEnd++; },
  showContextMenu: () => { calls.contextMenu++; },
  onFlee: (cb) => { fleeCb = cb; },
  onFleeEnd: (cb) => { fleeEndCb = cb; },
  onOfficeActive: (cb) => { officeCb = cb; },
  onDragEnd: (cb) => { dragEndCb = cb; },
  onRemind: (cb) => { remindCb = cb; },
};

// ---- 假时钟：精确控制冷却窗口
let fakeNow = 1_000_000;
const FakeDate = { now: () => fakeNow };
function advance(ms) { fakeNow += ms; }

const sandbox = {
  console,
  document,
  Image: function () { preloadCount++; return {}; },
  setInterval: (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id; },
  clearInterval: (id) => { const i = intervals.indexOf(id); if (i >= 0) intervals.splice(i, 1); },
  setTimeout: (fn, ms) => { const id = { fn, ms }; timeouts.push(id); return id; },
  clearTimeout: (id) => { const i = timeouts.indexOf(id); if (i >= 0) timeouts.splice(i, 1); },
  Date: FakeDate,
  Math,
  Promise,
  window: { StitchPet: CD },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

function fire(type, ev) {
  (docListeners[type] || []).forEach((f) => f(ev));
}
function tick(n = 1) {
  const cur = intervals[intervals.length - 1];
  for (let i = 0; i < n; i++) cur.fn();
}
// 触发最近调度的 setTimeout（测试中的最后一个总是审阅冷却恢复定时器）
function fireLastTimeout() {
  const t = timeouts.pop();
  if (t) t.fn();
}
const frameOf = () => sprite.src.match(/frame_(\d+)\.png$/)?.[1] || '(none)';
const actionOf = () => sprite.src.match(/assets\/(\w+)\//)?.[1] || '(none)';

(async function main() {
  await new Promise((r) => setImmediate(r)); // init 的 getMeta microtask

  console.log('init:');
  assert(preloadCount === 222, `全部 222 帧已预载 (实际 ${preloadCount})`);
  assert(actionOf() === 'idle1', `初始为待机动画 (实际 ${actionOf()})`);
  tick(3);
  assert(frameOf() === '00004', `待机帧推进 1→4 (实际 ${frameOf()})`);

  console.log('拖拽（只发起止信号）:');
  fire('pointerdown', { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
  for (let i = 1; i <= 5; i++) fire('pointermove', { button: 0, pointerId: 7, clientX: 100 + 4 * i, clientY: 100 + 2 * i });
  assert(calls.dragStart === 1, `dragStart 恰好发送 1 次 (实际 ${calls.dragStart})`);
  assert(actionOf() === 'drag', `进入抓起动画 (实际 ${actionOf()})`);
  tick(2);
  assert(actionOf() === 'drag' && frameOf() === '00003', `drag 帧推进 (实际 ${actionOf()}/${frameOf()})`);
  fire('pointerup', { button: 0, pointerId: 7 });
  assert(calls.dragEnd === 1, `松手发送 dragEnd 1 次 (实际 ${calls.dragEnd})`);
  assert(actionOf() === 'idle1', `松手回待机 (实际 ${actionOf()})`);

  console.log('窗口外松手（drag-end 转发，幂等）:');
  fire('pointerdown', { button: 0, pointerId: 8, clientX: 100, clientY: 100 });
  fire('pointermove', { button: 0, pointerId: 8, clientX: 130, clientY: 110 });
  fire('pointerup', { button: 0, pointerId: 8 }); // 渲染层自己处理
  const before = calls.dragEnd;
  dragEndCb(); // 主进程又转发一次（shield 路径）
  assert(calls.dragEnd === before, `重复 drag-end 不产生二次 IPC（幂等，实际 ${calls.dragEnd}）`);
  assert(actionOf() === 'idle1', `仍稳定在待机 (实际 ${actionOf()})`);

  console.log('窗口外松手（渲染层未收到 pointerup，仅转发）:');
  fire('pointerdown', { button: 0, pointerId: 9, clientX: 100, clientY: 100 });
  fire('pointermove', { button: 0, pointerId: 9, clientX: 130, clientY: 110 });
  const startCalls = calls.dragStart;
  dragEndCb(); // 只有主进程转发
  assert(calls.dragStart === startCalls, `无多余 dragStart`);
  assert(actionOf() === 'idle1', `drag-end 转发单独也能结束拖拽回待机 (实际 ${actionOf()})`);

  console.log('抓起动画播完定格末帧（问题 4）:');
  fire('pointerdown', { button: 0, pointerId: 30, clientX: 100, clientY: 100 });
  fire('pointermove', { button: 0, pointerId: 30, clientX: 130, clientY: 110 });
  assert(actionOf() === 'drag', `进入抓起动画 (实际 ${actionOf()})`);
  tick(10); // drag 共 5 帧：播完后再多 tick 也不应循环/回落
  assert(actionOf() === 'drag' && frameOf() === '00005', `播完定格末帧不循环不回落 (实际 ${actionOf()}/${frameOf()})`);
  fire('pointerup', { button: 0, pointerId: 30 });
  assert(actionOf() === 'idle1', `松手才回落待机 (实际 ${actionOf()})`);

  console.log('动作视觉缩放（问题 6/7）:');
  assert(sprite.style.transform === 'scale(0.75, 0.75)', `待机 0.75 倍 (实际 ${sprite.style.transform})`);

  console.log('奔跑方向镜像（问题 3）:');
  fleeCb({ left: true }); // 主进程判定向左跑
  assert(actionOf() === 'run', `触发跑开进入奔跑 (实际 ${actionOf()})`);
  assert(sprite.style.transform === 'scale(-1, 1)', `向左跑奔跑帧水平镜像 (实际 ${sprite.style.transform})`);
  fleeEndCb();
  assert(sprite.style.transform === 'scale(0.75, 0.75)', `回待机镜像复位 (实际 ${sprite.style.transform})`);
  fleeCb(); // 无载荷 = 向右跑
  assert(actionOf() === 'run', `再次触发跑开 (实际 ${actionOf()})`);
  assert(sprite.style.transform === 'scale(1, 1)', `向右跑保持原大不镜像 (实际 ${sprite.style.transform})`);
  fleeEndCb();
  assert(actionOf() === 'idle1', `跑开结束回待机 (实际 ${actionOf()})`);

  console.log('崩溃提醒气泡（问题 8，自定义时长载荷）:');
  remindCb({ text: '将日志信息下载下来，提供给代旭秋', ms: 12000 });
  assert(bubble.hidden === false, `气泡显示`);
  assert(bubbleText.textContent === '将日志信息下载下来，提供给代旭秋', `气泡文案正确 (实际 ${bubbleText.textContent})`);

  console.log('单击挥手:');
  advance(2000); // 跨过冷却
  fire('pointerdown', { button: 0, pointerId: 10, clientX: 100, clientY: 100 });
  fire('pointerup', { button: 0, pointerId: 10 });
  assert(actionOf() === 'wave', `左键单击触发挥手 (实际 ${actionOf()})`);
  tick(4);
  assert(actionOf() === 'wave' && frameOf() === '00005', `挥手帧推进 (实际 ${actionOf()}/${frameOf()})`);
  fire('pointerdown', { button: 0, pointerId: 11, clientX: 102, clientY: 101 });
  fire('pointerup', { button: 0, pointerId: 11 });
  assert(actionOf() === 'wave', `冷却期内连点不重复触发、不崩溃 (实际 ${actionOf()})`);
  tick(13);
  assert(actionOf() === 'idle1', `挥手播完回待机 (实际 ${actionOf()})`);

  console.log('右键审阅（20s 冷却）:');
  advance(2000);
  fire('pointerup', { button: 2, pointerId: 12 });
  assert(actionOf().startsWith('review'), `右键触发审阅 (实际 ${actionOf()})`);
  assert(calls.contextMenu >= 1, `右键同时请求上下文菜单 (实际 ${calls.contextMenu})`);
  tick(3);
  assert(actionOf().startsWith('review'), `审阅帧推进中 (实际 ${actionOf()})`);
  tick(64); // 播完一整套（review1=63 / review2=37 帧）→ settle 记录结束时刻
  assert(actionOf() === 'idle1', `审阅播完回待机、冷却开始 (实际 ${actionOf()})`);
  fire('pointerup', { button: 2, pointerId: 13 });
  assert(actionOf() === 'idle1', `冷却期内右键不重播审阅 (实际 ${actionOf()})`);
  assert(calls.contextMenu >= 2, `冷却期内右键菜单照常弹出 (实际 ${calls.contextMenu})`);
  advance(20000); // 冷却结束
  fire('pointerup', { button: 2, pointerId: 14 });
  assert(actionOf().startsWith('review'), `冷却结束后右键可再次触发 (实际 ${actionOf()})`);
  tick(3); // 停在播放中，供下一段跑开打断

  console.log('跑开（强制打断 + settle 回落，打断不消耗冷却）:');
  fleeCb();
  assert(actionOf() === 'run', `跑开强制打断审阅进入奔跑 (实际 ${actionOf()})`);
  tick(5);
  assert(actionOf() === 'run' && frameOf() === '00006', `奔跑帧推进 (实际 ${actionOf()}/${frameOf()})`);
  fleeEndCb();
  assert(actionOf() === 'idle1', `跑开结束回待机（办公不活跃）(实际 ${actionOf()})`);
  // run 的 maxMs 兜底：flee-end 丢失时 3200ms 后自然回落
  fleeCb();
  advance(3200);
  tick(1);
  assert(actionOf() === 'idle1', `flee-end 丢失时 maxMs 兜底回待机 (实际 ${actionOf()})`);

  console.log('办公审阅氛围（播完 → 20s 冷却 → 到期自动恢复）:');
  advance(2000);
  officeCb(true);
  assert(actionOf().startsWith('review'), `办公软件激活进入审阅 (实际 ${actionOf()})`);
  tick(64); // 播完一整套 → settle：冷却期内不立即重播
  assert(actionOf() === 'idle1', `审阅播完进入冷却、回落待机 (实际 ${actionOf()})`);
  officeCb(false); // 冷却中途切走 → 取消恢复定时器
  officeCb(true);  // 冷却期内重新激活 → 重新安排恢复
  assert(actionOf() === 'idle1', `冷却期内重新激活不立即进审阅 (实际 ${actionOf()})`);
  advance(20000); // 冷却到期
  fireLastTimeout(); // 触发恢复定时器
  assert(actionOf().startsWith('review'), `冷却到期自动恢复审阅 (实际 ${actionOf()})`);
  officeCb(false);
  assert(actionOf() === 'idle1', `办公切走回待机 (实际 ${actionOf()})`);

  console.log('办公活跃期间的用户交互回落到审阅（打断不消耗冷却）:');
  advance(21000); // 冷却已过
  officeCb(true);
  assert(actionOf().startsWith('review'), `再次进入审阅 (实际 ${actionOf()})`);
  // 拖拽结束 -> settle 回审阅
  fire('pointerdown', { button: 0, pointerId: 20, clientX: 100, clientY: 100 });
  fire('pointermove', { button: 0, pointerId: 20, clientX: 130, clientY: 110 });
  fire('pointerup', { button: 0, pointerId: 20 });
  assert(actionOf().startsWith('review'), `办公活跃时拖拽结束回审阅 (实际 ${actionOf()})`);
  // 跑开结束 -> settle 回审阅
  fleeCb();
  assert(actionOf() === 'run', `办公活跃时跑开仍可打断 (实际 ${actionOf()})`);
  fleeEndCb();
  assert(actionOf().startsWith('review'), `跑开结束回审阅 (实际 ${actionOf()})`);
  // 单击挥手打断审阅，播完回审阅
  advance(2000);
  fire('pointerdown', { button: 0, pointerId: 21, clientX: 100, clientY: 100 });
  fire('pointerup', { button: 0, pointerId: 21 });
  assert(actionOf() === 'wave', `审阅氛围中单击仍挥手（高优先级打断）(实际 ${actionOf()})`);
  tick(13);
  assert(actionOf().startsWith('review'), `挥手播完回审阅 (实际 ${actionOf()})`);
  officeCb(false);
  assert(actionOf() === 'idle1', `最终切走回待机 (实际 ${actionOf()})`);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

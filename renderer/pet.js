'use strict';
/* 史迪奇桌面宠物行为状态机（渲染进程）
 * 优先级：drag(抓起) > wave(挥手) > review(审阅) > run(奔跑) > idle(待机)
 * 触发：左键单击→挥手；宠物窗口内快扫（主进程光标监测）→跑开（位移由主进程驱动）；
 * 右键→审阅+菜单；办公软件前台活跃→审阅氛围（播完冷却 20s 后自动重播，settle 统一裁决回落点）；
 * 左键按住拖动 ≥6px→抓起。
 * 帧播放：每个动作目录的真实帧数来自主进程 assets:meta，逐帧推进整段序列。
 * 拖拽：pointerdown 捕获指针，超阈值后只发 dragStart/dragEnd 起止信号，
 * 窗口由主进程按绝对位置（光标 − 固定抓取偏移）跟随，渲染层不计算位移。
 */

const CD = window.StitchPet;

// ---------------- 行为定义（★ 动作核心参数，改这里）
// 字段说明：
//   priority         优先级（数值大者高）：drag(4) > wave(3) > review(2) > run(1) > idle(0)；
//                    仅更高优先级可打断当前动作；drag 不可被打断
//   loops            true=播完后循环重播；false=播完一整套回落（经 settle()）
//   actions / action 多套动作随机挑选（idle/review 两套随机），或单一动作
//   frameIntervalMs  每帧间隔 ms，数值越小播得越快
//   maxMs            该行为最长持续 ms（超时强制回落；不写=不限）
// ⚠ config.json 的 behaviors 段仅作参考，实际生效以此处为准
const BEHAVIORS = {
  idle:  { priority: 0, loops: true,  actions: ['idle1', 'idle2'], frameIntervalMs: 66 },     // 待机：两套随机交替
  run:   { priority: 1, loops: true,  action: 'run',  frameIntervalMs: 55, maxMs: 3200 },     // 奔跑：maxMs 兜底 flee-end 丢失
  review:{ priority: 2, loops: false, actions: ['review1', 'review2'], frameIntervalMs: 40 }, // 审阅：办公氛围下循环重入
  wave:  { priority: 3, loops: false, action: 'wave', frameIntervalMs: 85 },                  // 挥手：左键单击触发
  drag:  { priority: 4, loops: false, holdLast: true, action: 'drag', frameIntervalMs: 100 }, // 抓起：播完定格末帧，松手才回落（问题 4）
};

// ---------------- 动作视觉缩放表（★ 问题 6+7，改这里）
// 值 = 该动作帧图的显示倍率（CSS scale，窗口/碰撞箱/拖拽数学不变，纯视觉缩放）。
//   run 保持 1        —— 逃跑瞬间"变大"的戏剧效果；
//   其余动作 0.75     —— 非奔跑素材整体缩小到 0.75 倍；
//   idle2 附加等高系数 0.9867 —— 实测 idle1 高 185.25px / idle2 高 187.75px，
//   两套素材原尺寸差 3px，交替播放时顶端会跳动（问题 6）；此系数让两者显示高度一致。
//   （配 style.css 的 #sprite transform-origin: 50% 100% 底部中心锚定：脚不动、向上缩放）
const ACTION_VISUAL = {
  run:    1,
  idle1:  0.75,
  idle2:  0.75 * 0.9867,
  wave:   0.75,
  review1: 0.75,
  review2: 0.75,
  drag:   0.75,
};

// ---------------- 交互参数（★ 冷却/阈值，改这里；config.json 同名项仅作参考）
const COOLDOWN = {
  review: 20000, // ★ 审阅动画冷却 ms：完整播完一次后需间隔这么久才能再次进入
                 //   （右键触发与办公氛围重入共用；被拖拽/跑开/挥手打断不消耗冷却）
  wave: 1200,    // 左键单击挥手冷却 ms
};
const INTERACTION = {
  dragThreshold: 6, // 拖拽判定阈值 px：按住后移动超过它才算拖拽，否则视为单击
};

// ---------------- 状态
const state = {
  current: 'idle',
  action: 'idle1',      // 当前动作目录
  frameCount: 1,        // 该动作真实帧数
  frameIdx: 0,          // 当前帧索引（0 基）
  intervalMs: 66,
  loops: true,
  holdLast: false,      // 播完定格末帧（抓起动作，问题 4）
  maxMs: null,
  behaviorStart: 0,
  timer: null,
  meta: { actions: {} },
  pressing: false,
  dragging: false,
  pressX: 0,
  pressY: 0,
  pointerId: null,
  lastWave: 0,         // 上次挥手时间戳（配合 COOLDOWN.wave）
  lastReviewEnd: 0,    // 上次审阅【完整播完】的时刻（配合 COOLDOWN.review；被打断不更新）
  officeActive: false, // 办公软件前台是否活跃（主进程推送；settle 的回落依据）
  runMirrored: false,  // 奔跑朝向是否向左（true=奔跑帧水平镜像；素材脸朝右，问题 3）
};

const sprite = document.getElementById('sprite');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');

// ---------------- 帧
// 帧文件路径：assets/<动作目录>/frame_00001.png（5 位序号，从 1 起）
const frameUrl = (action, i) => `../assets/${action}/frame_${String(i + 1).padStart(5, '0')}.png`;

// 动作真实帧数：来自主进程 assets:meta（assets/meta.json），无数据时兜底 1 帧
function frameCountOf(action) {
  const info = state.meta.actions[action];
  return (info && info.frames > 0) ? info.frames : 1;
}

function drawFrame() {
  sprite.src = frameUrl(state.action, state.frameIdx);
  // 视觉缩放（问题 6+7）：按动作查表；奔跑向左时水平镜像（素材脸朝右，问题 3）
  const scale = ACTION_VISUAL[state.action] || 1;
  const sx = (state.current === 'run' && state.runMirrored) ? -scale : scale;
  sprite.style.transform = `scale(${sx}, ${scale})`;
}

// 帧循环：按当前动作的 intervalMs 定时推进（换动作时重启定时器）
function startLoop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => tick(), state.intervalMs);
}

function tick() {
  if (state.maxMs && Date.now() - state.behaviorStart >= state.maxMs) {
    settle();
    return;
  }
  state.frameIdx++;
  if (state.frameIdx >= state.frameCount) {
    if (state.holdLast) {
      state.frameIdx = state.frameCount - 1; // 定格末帧（抓起动画不循环，问题 4）
    } else if (!state.loops) {
      settle();
      return;
    } else {
      state.frameIdx = 0;
      if (state.current === 'idle') {
        // 待机：完整播完一套后随机换另一套，制造循环差异
        state.action = Math.random() < 0.5 ? 'idle1' : 'idle2';
        state.frameCount = frameCountOf(state.action);
      }
    }
  }
  drawFrame();
}

// ---------------- 行为
function pickAction(behavior) {
  const spec = BEHAVIORS[behavior];
  if (spec.actions) {
    if (spec.actions.length === 1) return spec.actions[0];
    return spec.actions[Math.floor(Math.random() * spec.actions.length)]; // idle/review 两套随机
  }
  return spec.action;
}

// ---------------- 审阅冷却（★ COOLDOWN.review = 20000ms）
// 锚点 = 上次审阅【完整播完】的时刻（settle 离开审阅时记录）；
// 被拖拽/跑开/挥手打断不消耗冷却——打断结束后氛围立即回审阅。
// 办公氛围处于冷却期时先回待机，由恢复定时器在到期后自动重进审阅。
let reviewResumeTimer = null; // 冷却到期自动恢复审阅的定时器句柄

function reviewReady() {
  return !state.lastReviewEnd || Date.now() - state.lastReviewEnd >= COOLDOWN.review;
}

function clearReviewResume() {
  if (reviewResumeTimer) { clearTimeout(reviewResumeTimer); reviewResumeTimer = null; }
}

function scheduleReviewResume() {
  clearReviewResume();
  const remain = COOLDOWN.review - (Date.now() - state.lastReviewEnd);
  reviewResumeTimer = setTimeout(() => {
    reviewResumeTimer = null;
    // 到期时仍在办公氛围且停在待机 → 自动恢复审阅（否则交由 settle 兜底）
    if (state.officeActive && state.current === 'idle' && reviewReady()) startBehavior('review');
  }, Math.max(0, remain)); // 剩余冷却 ms
}

// 切换行为：随机挑套 → 重置帧索引 → 按该行为帧率重启循环
function startBehavior(behavior) {
  if (behavior === 'review') clearReviewResume(); // 已进入审阅 → 恢复定时器作废
  const spec = BEHAVIORS[behavior];
  state.current = behavior;
  state.action = pickAction(behavior);
  state.frameCount = frameCountOf(state.action);
  state.frameIdx = 0;
  state.intervalMs = spec.frameIntervalMs;
  state.loops = spec.loops;
  state.holdLast = !!spec.holdLast;
  state.maxMs = spec.maxMs || null;
  state.behaviorStart = Date.now();
  if (behavior !== 'run') state.runMirrored = false; // 镜像仅对奔跑生效（朝向由 onFlee 载荷先行设置）
  drawFrame();
  startLoop();
}

// 进入待机（从待机1起，播完一套后 tick 内随机换套）
function startIdle() {
  const spec = BEHAVIORS.idle;
  state.current = 'idle';
  state.action = 'idle1';
  state.frameCount = frameCountOf(state.action);
  state.frameIdx = 0;
  state.intervalMs = spec.frameIntervalMs;
  state.loops = true;
  state.holdLast = false;
  state.maxMs = null;
  state.behaviorStart = Date.now();
  state.runMirrored = false;
  drawFrame();
  startLoop();
}

// 自然回落点统一裁决：办公前台活跃时回到审阅（氛围保持），否则回待机。
// 审阅为非循环动作，播完经此函数重入；受 COOLDOWN.review 约束——
// 冷却期内（含刚播完）先回待机，由恢复定时器到期自动重进审阅；
// 从审阅被打断后经此回落时冷却已足够（打断不消耗），直接回审阅。
function settle() {
  if (state.current === 'review') state.lastReviewEnd = Date.now(); // 审阅停止（播完/办公切走）→ 冷却起点
  if (state.officeActive) {
    if (reviewReady()) startBehavior('review');
    else { startIdle(); scheduleReviewResume(); }
  } else {
    startIdle();
  }
}

// 按优先级请求切换；drag 不可被打断；仅更高优先级可打断
function request(behavior) {
  if (behavior === state.current) return;
  if (state.current === 'drag') return;
  const cur = BEHAVIORS[state.current].priority;
  const next = BEHAVIORS[behavior].priority;
  if (cur >= next) return;
  startBehavior(behavior);
}

// ---------------- 气泡
// ms 可自定义显示时长（★ 默认 6000ms；崩溃日志提醒用 12000ms）
function showBubble(text, ms = 6000) {
  bubbleText.textContent = text;
  bubble.hidden = false;
  clearTimeout(showBubble._t);
  showBubble._t = setTimeout(() => { bubble.hidden = true; }, ms); // ★ 气泡显示时长 ms
}

// ---------------- 交互（Pointer Events）
const stage = document.getElementById('stage');

function onPointerDown(e) {
  if (e.button !== 0) return;
  state.pressing = true;
  state.dragging = false;
  state.pressX = e.clientX;
  state.pressY = e.clientY;
  state.pointerId = e.pointerId;
  // 捕获指针：鼠标滑出窗口后仍能收到 pointerup/pointercancel，拖拽状态不会卡死
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 已释放等情况忽略 */ }
}

function onPointerMove(e) {
  if (!state.pressing) return;
  if (!state.dragging) {
    const dx = e.clientX - state.pressX;
    const dy = e.clientY - state.pressY;
    if (Math.abs(dx) <= INTERACTION.dragThreshold && Math.abs(dy) <= INTERACTION.dragThreshold) return;
    state.dragging = true;
    request('drag');
    CD.dragStart();
  }
}

function onPointerUp(e) {
  if (e.button === 0) {
    state.pressing = false;
    if (state.dragging) {
      state.dragging = false;
      CD.dragEnd();
      settle();
      return;
    }
    triggerWave(); // 左键单击（未构成拖拽）→ 挥手
  } else if (e.button === 2) {
    state.pressing = false;
    triggerReview();
    CD.showContextMenu();
  }
}

function onPointerCancel() {
  state.pressing = false;
  if (state.dragging) {
    state.dragging = false;
    CD.dragEnd();
    settle();
  }
}

function triggerWave() {
  const now = Date.now();
  if (now - state.lastWave < COOLDOWN.wave) return;
  state.lastWave = now;
  request('wave');
}

function triggerReview() {
  if (!reviewReady()) return; // 冷却期内右键不再重播审阅（上下文菜单照常弹出）
  request('review');
}

// ---------------- 绑定
document.addEventListener('pointerdown', onPointerDown);
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', onPointerCancel);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 窗口内快速滑动 -> 跑开（主进程光标监测触发，冷却在主进程侧）。
// 直接 startBehavior 有意绕过优先级：受惊逃跑可打断审阅/挥手，但不可打断拖拽。
// 载荷 { left }：向左跑 → 奔跑帧水平镜像（素材脸朝右，问题 3）
if (CD.onFlee) CD.onFlee((d) => {
  if (state.current === 'drag') return;
  state.runMirrored = !!(d && d.left);
  startBehavior('run');
});
if (CD.onFleeEnd) CD.onFleeEnd(() => { if (state.current === 'run') settle(); });

// 办公软件前台活跃 -> 审阅氛围：进入时从待机切入（冷却期内改为安排到期自动进入），
// 切走时取消恢复定时器并回落（其余时机由 settle 在各自然回落点裁决）
if (CD.onOfficeActive) CD.onOfficeActive((active) => {
  state.officeActive = active;
  if (active) {
    if (state.current === 'idle') {
      if (reviewReady()) startBehavior('review');
      else scheduleReviewResume(); // 冷却期内激活：等到期自动进入（期间保持待机）
    }
  } else {
    clearReviewResume();
    if (state.current === 'review') settle();
  }
});

// 窗口外松手：由事件盾经主进程转发 drag-end（宠物窗口自身 pointerup 已先行处理时幂等跳过）
if (CD.onDragEnd) CD.onDragEnd(() => {
  if (state.dragging) {
    state.dragging = false;
    state.pressing = false;
    settle();
  }
});

// 提醒气泡（payload 可带 ms 自定义时长；崩溃日志提醒 12s）
if (CD.onRemind) CD.onRemind(({ text, ms }) => showBubble(text, ms));

// ---------------- 启动：先取动作帧元数据，预载全部帧图，再进入待机
function preloadFrames() {
  for (const [action, info] of Object.entries(state.meta.actions)) {
    for (let i = 0; i < (info.frames || 1); i++) {
      const img = new Image();
      img.src = frameUrl(action, i);
    }
  }
}

(async function init() {
  try {
    if (CD.getMeta) state.meta = await CD.getMeta();
  } catch (e) { /* meta 不可用时兜底：每动作按 1 帧 */ }
  preloadFrames();
  startIdle();
})();

'use strict';
/* ============================================================================
 * 跑开位移数学（flee.js，纯函数，不依赖 electron）
 * ============================================================================
 * 供 main.js require 使用；因 CDP 合成事件不动真实光标，主进程路径无法自动化测试，
 * 位移数学全部抽到这里由 tools/test_flee.js 离线单测覆盖。
 * ★ 可调参数就下面两个常量（方向/收边/换向逻辑见函数内注释）
 */

const EDGE_MARGIN = 10;    // ★ 跑开目标距工作区边缘的最小余量 px（防贴边/被任务栏遮挡）
const MIN_EFFECTIVE = 120; // ★ 收边后视为有效逃跑的最小位移 px（不足则自动换向）

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/* ============================================================================
 * 快扫累计器（问题 3）：光标在宠物窗口内【累计】位移达阈值即触发跑开
 * ============================================================================
 * 语义：一次划动 / 来回多段均可累计（旧实现要求单个 40ms 采样 ≥60px ≈ 1500px/s，
 * 实测一次 200px 划过仅 ~53px/样本，导致"要来回划 3 次"才偶然命中）。
 * ★ 阈值 thresholdPx / 采样超时 gapMs 由 main.js 从 config.json
 *   interaction.swipeTravelPx / swipeGapMs 传入（swipeTravelPx 越小越灵敏）。
 */
class SwipeAccumulator {
  constructor(thresholdPx, gapMs) {
    this.threshold = thresholdPx; // 窗内累计位移触发阈值 px
    this.gap = gapMs;             // 相邻采样最大间隔 ms（超时丢弃累计，防慢速漂移误触）
    this.reset();
  }

  reset() {
    this.last = null;    // 上次采样光标（null=尚未建立基准）
    this.lastTime = 0;   // 上次采样时间戳 ms
    this.total = 0;      // 窗内累计位移 px
  }

  /**
   * 喂入一次光标采样。
   * @param cursor  {x, y} 当前光标屏幕坐标
   * @param petRect {x, y, width, height} 宠物窗口矩形
   * @param nowMs   当前时间戳 ms
   * @returns true = 累计位移已达阈值（调用方应 reset() 并触发跑开）
   */
  sample(cursor, petRect, nowMs) {
    // 光标不在宠物窗口内 → 清零（出窗期间不计入）
    const inside = cursor.x >= petRect.x && cursor.x <= petRect.x + petRect.width &&
                   cursor.y >= petRect.y && cursor.y <= petRect.y + petRect.height;
    if (!inside) { this.reset(); return false; }

    // 首次进窗：仅建立基准
    if (!this.last) {
      this.last = { x: cursor.x, y: cursor.y };
      this.lastTime = nowMs;
      return false;
    }

    // 采样间隔超时 → 丢弃累计、重建基准（相当于重新开始一次划动）
    if (nowMs - this.lastTime > this.gap) {
      this.total = 0;
      this.last = { x: cursor.x, y: cursor.y };
      this.lastTime = nowMs;
      return false;
    }

    // 累加本段位移（存副本，避免外部对象被复用后污染 last）
    this.total += Math.hypot(cursor.x - this.last.x, cursor.y - this.last.y);
    this.last = { x: cursor.x, y: cursor.y };
    this.lastTime = nowMs;
    return this.total >= this.threshold;
  }
}

function norm(x, y) {
  const len = Math.hypot(x, y);
  if (len < 1e-6) return null;
  return { x: x / len, y: y / len };
}

/* 候选方向收边后的位移长度（整个窗口须留在工作区内，含边距） */
function clampDisplacement(petRect, dir, workArea, distance) {
  const tx = petRect.x + dir.x * distance;
  const ty = petRect.y + dir.y * distance;
  const cx = Math.min(Math.max(tx, workArea.x + EDGE_MARGIN), workArea.x + workArea.width - petRect.width - EDGE_MARGIN);
  const cy = Math.min(Math.max(ty, workArea.y + EDGE_MARGIN), workArea.y + workArea.height - petRect.height - EDGE_MARGIN);
  return { x: cx, y: cy, dist: Math.hypot(cx - petRect.x, cy - petRect.y) };
}

/**
 * 计算跑开目标点（窗口左上角坐标）。
 * @param petRect   {x, y, width, height} 宠物窗口矩形
 * @param cursor    {x, y} 触发时光标位置
 * @param swipe     {x, y} 本次采样滑动向量（光标压在中心时的退化方向）
 * @param workArea  {x, y, width, height} 当前显示器工作区
 * @param distance  跑开距离 px
 * @returns {target: {x, y}, dist: number} 目标窗口左上角与实际位移
 */
function computeFleeTarget(petRect, cursor, swipe, workArea, distance) {
  const cx = petRect.x + petRect.width / 2;
  const cy = petRect.y + petRect.height / 2;

  // 主方向：远离光标（光标 → 宠物中心）；退化顺序：滑动向量 → 随机角度
  let dir = norm(cx - cursor.x, cy - cursor.y);
  if (!dir) dir = norm(swipe.x, swipe.y);
  if (!dir) dir = norm(Math.random() * 2 - 1, Math.random() * 2 - 1);

  // 候选：主方向、反向、左转90°、右转90°（应对屏边收边后位移不足）
  const candidates = [
    dir,
    { x: -dir.x, y: -dir.y },
    { x: -dir.y, y: dir.x },
    { x: dir.y, y: -dir.x },
  ];

  let best = null;
  for (const c of candidates) {
    const r = clampDisplacement(petRect, c, workArea, distance);
    if (!best || r.dist > best.dist) best = r;
    if (r.dist >= MIN_EFFECTIVE) return { target: { x: r.x, y: r.y }, dist: r.dist };
  }
  return { target: { x: best.x, y: best.y }, dist: best.dist };
}

module.exports = { computeFleeTarget, easeOutCubic, SwipeAccumulator, EDGE_MARGIN, MIN_EFFECTIVE };

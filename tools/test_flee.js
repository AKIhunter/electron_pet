'use strict';
/* 跑开位移数学单元测试：node tools/test_flee.js（无需 electron）
 * 覆盖：跑开方向/收边/换向 + SwipeAccumulator 快扫累计触发（问题 3） */
const { computeFleeTarget, easeOutCubic, SwipeAccumulator, EDGE_MARGIN, MIN_EFFECTIVE } = require('../flee.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok - ${msg}`); }
  else { fail++; console.error(`  FAIL - ${msg}`); }
}

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const PET = { x: 900, y: 400, width: 256, height: 256 };

console.log('== 跑开方向：远离光标 ==');
{
  // 光标在宠物左侧 -> 宠物向右跑
  const { target, dist } = computeFleeTarget(PET, { x: 800, y: 528 }, { x: 5, y: 0 }, AREA, 400);
  assert(target.x > PET.x, `目标在宠物右侧 (${PET.x} -> ${target.x})`);
  assert(dist >= MIN_EFFECTIVE, `位移 ${dist} >= ${MIN_EFFECTIVE}`);
  assert(target.x <= AREA.width - EDGE_MARGIN, `目标未超右边界 (x=${target.x})`);
}
{
  // 光标在宠物上方 -> 宠物向下跑
  const { target } = computeFleeTarget(PET, { x: 1028, y: 300 }, { x: 0, y: 5 }, AREA, 400);
  assert(target.y > PET.y, `目标在宠物下方 (${PET.y} -> ${target.y})`);
}

console.log('== 屏边收边与换向 ==');
{
  // 宠物在右下角，光标在左上 -> 主方向(右下)撞屏边 -> 换向候选
  const pet = { x: 1600, y: 700, width: 256, height: 256 };
  const { target, dist } = computeFleeTarget(pet, { x: 1500, y: 600 }, { x: 5, y: 5 }, AREA, 400);
  assert(target.x >= AREA.x + EDGE_MARGIN && target.x + pet.width <= AREA.x + AREA.width - EDGE_MARGIN, `x 收边合法（整窗在内）(${target.x})`);
  assert(target.y >= AREA.y + EDGE_MARGIN && target.y + pet.height <= AREA.y + AREA.height - EDGE_MARGIN, `y 收边合法（整窗在内）(${target.y})`);
  assert(dist >= MIN_EFFECTIVE, `换向后位移 ${dist} >= ${MIN_EFFECTIVE}`);
}

console.log('== 极小工作区：窗口整体留在区内且不崩溃 ==');
{
  const tiny = { x: 0, y: 0, width: 400, height: 400 };
  const pet = { x: 100, y: 100, width: 256, height: 256 };
  const { target, dist } = computeFleeTarget(pet, { x: 0, y: 0 }, { x: 3, y: 3 }, tiny, 400);
  assert(target.x >= tiny.x + EDGE_MARGIN && target.x + pet.width <= tiny.x + tiny.width - EDGE_MARGIN, `x 收边合法（整窗在内）(${target.x})`);
  assert(target.y >= tiny.y + EDGE_MARGIN && target.y + pet.height <= tiny.y + tiny.height - EDGE_MARGIN, `y 收边合法（整窗在内）(${target.y})`);
  assert(Number.isFinite(dist) && dist >= 0, `位移有限 (${dist})`);
}

console.log('== 光标压在中心：退化到滑动向量 ==');
{
  const pet = { x: 832, y: 392, width: 256, height: 256 }; // 中心 (960, 520)
  const { target } = computeFleeTarget(pet, { x: 960, y: 520 }, { x: 10, y: 0 }, AREA, 400);
  assert(target.x > pet.x, `沿滑动向量向右 (${pet.x} -> ${target.x})`);
}

console.log('== 副屏负坐标 ==');
{
  const area = { x: -2326, y: 1004, width: 496, height: 1296 };
  const pet = { x: -2200, y: 1100, width: 256, height: 256 };
  const { target, dist } = computeFleeTarget(pet, { x: -2100, y: 1228 }, { x: 5, y: 0 }, area, 400);
  assert(target.x >= area.x + EDGE_MARGIN && target.x <= area.x + area.width - EDGE_MARGIN, `副屏 x 收边合法 (${target.x})`);
  assert(target.y >= area.y + EDGE_MARGIN && target.y <= area.y + area.height - EDGE_MARGIN, `副屏 y 收边合法 (${target.y})`);
  assert(dist >= MIN_EFFECTIVE, `副屏位移 ${dist} >= ${MIN_EFFECTIVE}`);
}

console.log('== easeOutCubic ==');
assert(easeOutCubic(0) === 0, 't=0 -> 0');
assert(easeOutCubic(1) === 1, 't=1 -> 1');
assert(Math.abs(easeOutCubic(0.5) - 0.875) < 1e-9, 't=0.5 -> 0.875');
assert(easeOutCubic(0.3) > 0.3, '前段加速（缓出特征）');

console.log('== SwipeAccumulator：一次 200px 划动即触发（问题 3） ==');
{
  const acc = new SwipeAccumulator(200, 250);
  const rect = { x: 900, y: 400, width: 256, height: 256 };
  // 一次划过：从窗左缘向右 5 个采样各 50px（40ms 间隔匀速累计，无需瞬时高速）
  acc.sample({ x: 905, y: 528 }, rect, 0);
  let fired = false;
  for (let i = 1; i <= 5; i++) {
    if (acc.sample({ x: 905 + 50 * i, y: 528 }, rect, i * 40)) { fired = true; break; }
  }
  assert(fired, '单段匀速划过一次即触发（旧实现需 3 次）');
  assert(acc.total >= 200, `累计位移 ${acc.total.toFixed(1)} >= 200`);
}
{
  // 来回多段累计也可触发（用户"来回移动"同样有效）
  const acc = new SwipeAccumulator(200, 250);
  const rect = { x: 900, y: 400, width: 256, height: 256 };
  acc.sample({ x: 1000, y: 528 }, rect, 0);
  let fired = false;
  for (let i = 1; i <= 6; i++) {
    const x = i % 2 === 0 ? 1000 + 40 : 1000 - 40; // 左右往复各 80px/段
    if (acc.sample({ x, y: 528 }, rect, i * 40)) { fired = true; break; }
  }
  assert(fired, '来回往复累计 200px 也能触发');
}
{
  // 光标出窗 → 累计清零
  const acc = new SwipeAccumulator(200, 250);
  const rect = { x: 900, y: 400, width: 256, height: 256 };
  acc.sample({ x: 1000, y: 528 }, rect, 0);
  acc.sample({ x: 1100, y: 528 }, rect, 40); // 窗内 +100
  acc.sample({ x: 1500, y: 528 }, rect, 80); // 出窗
  assert(acc.total === 0 && acc.last === null, '出窗后累计清零');
}
{
  // 采样间隔超过 gapMs → 丢弃累计重建基准（慢速漂移不误触）
  const acc = new SwipeAccumulator(200, 250);
  const rect = { x: 900, y: 400, width: 256, height: 256 };
  acc.sample({ x: 1000, y: 528 }, rect, 0);
  acc.sample({ x: 1120, y: 528 }, rect, 40); // +120
  assert(acc.total >= 120, `短间隔累计生效 (${acc.total.toFixed(0)}px)`);
  const fired = acc.sample({ x: 1130, y: 528 }, rect, 40 + 6000); // 6 秒后来的慢速小位移
  assert(!fired && acc.total < 120, `gap 超时后累计重置，慢速漂移不触发 (${acc.total.toFixed(0)}px)`);
}
{
  // 纯慢速漂移（每 240ms 移 3px，间隔内但累计慢慢涨）：未到阈值不触发——阈值语义由调用方冷却兜底
  const acc = new SwipeAccumulator(200, 250);
  const rect = { x: 900, y: 400, width: 256, height: 256 };
  acc.sample({ x: 1000, y: 528 }, rect, 0);
  let fired = false;
  for (let i = 1; i <= 30; i++) {
    if (acc.sample({ x: 1000 + 3 * i, y: 528 }, rect, i * 240)) { fired = true; break; }
  }
  // 30 段 ×3px = 90px < 200 → 不触发
  assert(!fired, '90px 慢速累计未达 200 阈值不触发');
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

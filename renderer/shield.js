'use strict';
/* ============================================================================
 * 拖拽事件盾（shield.js，在 shield.html 全屏透明窗口中运行）
 * ============================================================================
 * 覆盖全屏、层级最高的透明窗口（无用户可调参数，逻辑说明见 main.js createDragShield）。
 * 光标在宠物窗口外松手时由本窗口接收 pointerup 并转发 dragEnd，
 * 防止拖拽状态卡死（窗口一直跟随鼠标）。
 */
window.addEventListener('pointerup', (e) => {
  if (e.button === 0) window.StitchPet.dragEnd();
});
// 兜底：若 dragEnd 意外丢失导致盾牌残留（挡住全屏交互），
// 用户任何新的鼠标按下都会经此通道强制结束拖拽并销毁盾牌
window.addEventListener('pointerdown', () => { window.StitchPet.dragEnd(); });
window.addEventListener('contextmenu', (e) => e.preventDefault()); // 屏蔽全屏右键菜单

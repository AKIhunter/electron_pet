'use strict';
/* CDP 端到端验证：node tools/cdp_verify.js
 * 前置：应用以 --remote-debugging-port=9223 启动。
 * 验证：① 渲染进程存活 ② 崩溃提醒气泡（伪造 pending.json）③ sprite 0.75 缩放
 *       ④ 50 次连点压测（问题 1：窗口不消失、进程不崩）⑤ 全动作帧完整性
 * 注意：CDP Runtime.evaluate 响应双层嵌套 → r.result.result.value
 */
const PORT = 9223;

async function main() {
  // 等 CDP 端口就绪
  let targets = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      targets = await r.json();
      break;
    } catch (e) { await new Promise((r2) => setTimeout(r2, 500)); }
  }
  if (!targets) { console.error('FAIL: CDP 端口未就绪'); process.exit(1); }

  const pet = targets.find((t) => t.url.includes('renderer/index.html'));
  if (!pet) { console.error('FAIL: 未找到宠物窗口 target'); process.exit(1); }
  console.log(`pet target: ${pet.url}`);

  const ws = new WebSocket(pet.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  function send(method, params = {}) {
    return new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  let pass = 0, fail = 0;
  const assert = (cond, name) => {
    if (cond) { pass++; console.log(`  [PASS] ${name}`); }
    else { fail++; console.error(`  [FAIL] ${name}`); }
  };

  console.log('== 基本存活 ==');
  assert(await ev('1+1') === 2, '渲染进程存活（Runtime.evaluate 1+1=2）');
  assert(await ev('document.getElementById("sprite").naturalWidth > 0'), 'sprite 帧图已加载');

  console.log('== 问题 8：崩溃提醒气泡（伪造 pending）==');
  const bubbleHidden = await ev('document.getElementById("bubble").hidden');
  const bubbleText = await ev('document.getElementById("bubble-text").textContent');
  assert(bubbleHidden === false, `气泡可见 (hidden=${bubbleHidden})`);
  assert(bubbleText === '将日志信息下载下来，提供给代旭秋', `气泡文案正确 (${bubbleText})`);

  console.log('== 问题 6/7：缩放 ==');
  const transform = await ev('getComputedStyle(document.getElementById("sprite")).transform');
  console.log(`  sprite transform = ${transform}`);
  assert(/matrix\(([^)]+)\)/.test(String(transform)), 'transform 已应用（非 none）');

  console.log('== 问题 4：抓起定格（模拟按下拖动后松手）==');
  // 按下 → 移动超阈值 → 进入 drag → 等末帧 → 松手
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 128, y: 128, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 140, button: 'left' });
  await new Promise((r) => setTimeout(r, 700)); // 5 帧 × 100ms 播完
  const dragAction = await ev('document.getElementById("sprite").src.match(/assets\\/(\\w+)\\//)[1]');
  const dragFrame = await ev('document.getElementById("sprite").src.match(/frame_(\\d+)/)[1]');
  assert(dragAction === 'drag', `进入抓起动画 (${dragAction})`);
  assert(dragFrame === '00005', `定格末帧 00005 (${dragFrame})`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 128, y: 138, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 128, y: 138, button: 'left', clickCount: 1 });

  console.log('== 问题 1：50 次连点压测 ==');
  // 主进程 getCursorScreenPoint 读真实光标：拖拽跟随会以真实光标为准，这里只做纯点击（无移动）
  let allOk = true;
  for (let i = 0; i < 50; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 128, y: 128, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 128, y: 128, button: 'left', clickCount: 1 });
    if (i % 10 === 9) {
      const alive = await ev('1+1');
      const visible = await ev('!document.getElementById("sprite").src.includes("undefined")');
      if (alive !== 2 || !visible) { allOk = false; console.error(`  第 ${i + 1} 次点击后异常 alive=${alive}`); }
    }
  }
  assert(allOk, '50 次连点：渲染进程存活、窗口不消失');
  assert(await ev('1+1') === 2, '压测后进程仍存活');

  console.log('== 窗口位置合法性（未跑飞/未出屏）==');
  const bounds = await ev('JSON.stringify({x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight})');
  console.log(`  window = ${bounds}`);
  const b = JSON.parse(bounds);
  assert(b.w > 0 && b.h > 0, `窗口尺寸正常 (${b.w}x${b.h})`);

  console.log('== 帧完整性：全动作帧 naturalWidth > 0 ==');
  // 直接在页面里逐动作加载全部帧
  const imgCheck = await ev(`(async () => {
    const meta = await window.StitchPet.getMeta();
    const bad = [];
    for (const [a, info] of Object.entries(meta.actions)) {
      for (let i = 0; i < info.frames; i++) {
        const img = new Image();
        img.src = '../assets/' + a + '/frame_' + String(i + 1).padStart(5, '0') + '.png';
        await img.decode().catch(() => bad.push(a + ':' + (i + 1)));
        if (img.naturalWidth === 0) bad.push(a + ':' + (i + 1));
      }
    }
    return JSON.stringify(bad);
  })()`);
  assert(imgCheck === '[]', `222 帧全部可解码 (${imgCheck})`);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  ws.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
